import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool"

import { DEFAULT_MAX_SYMBOLS } from "./constants"
import { formatSymbolKind } from "./lsp-formatters"
import { withLspClient } from "./lsp-client-wrapper"
import {
  expandPackageNames,
  resolvePackage,
  scanDtsExports,
  toNodeModulesRelativePath,
  toWorkspaceRoot,
} from "./package-resolution"
import type { DtsExport, UnifiedSymbolKind } from "./package-resolution"
import { ensureLspServersInstalled } from "./server-auto-installer"
import { errorResult, locationToRef, okResult, type LocationRef } from "./tool-result"
import type { DocumentSymbol, SymbolInfo } from "./types"

type KindFilter =
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "function"
  | "variable"
  | "namespace"

const KIND_FILTER_MAP: Record<KindFilter, UnifiedSymbolKind[]> = {
  class: ["Class"],
  interface: ["Interface"],
  type: ["TypeAlias"],
  enum: ["Enum"],
  function: ["Function"],
  variable: ["Variable"],
  namespace: ["Namespace"],
}

interface SymbolSummary {
  name: string
  kind: string
  location?: LocationRef
  containerName?: string
  symbolPath?: string[]
  signature?: string
  documentation?: string
  isReExport?: boolean
}

interface PackageDiscovery {
  packageName: string
  packageRoot?: string
  nodeModulesRoot?: string | null
  symbols: SymbolSummary[]
  total: number
  shown: number
}

interface DiscoverData {
  input: {
    filePath?: string
    packageName?: string | string[]
    query?: string
    kinds?: string[]
  }
  packages?: PackageDiscovery[]
  fileSymbols?: SymbolSummary[]
  workspaceSymbols?: SymbolSummary[]
  total: number
  shown: number
}

function filterPackageExports(
  items: DtsExport[],
  opts: { query?: string; kinds?: KindFilter[] },
): DtsExport[] {
  let output = items.filter((item) => item.kind !== "Unknown")

  if (opts.query) {
    const q = opts.query.toLowerCase()
    output = output.filter((item) => item.name.toLowerCase().includes(q))
  }

  if (opts.kinds && opts.kinds.length > 0) {
    const allowed = new Set<UnifiedSymbolKind>()
    for (const kind of opts.kinds) {
      for (const mapped of KIND_FILTER_MAP[kind] ?? []) allowed.add(mapped)
    }
    output = output.filter((item) => allowed.has(item.kind))
  }

  return output
}

function dtsExportToSummary(item: DtsExport, nodeModulesRoot: string | null): SymbolSummary {
  return {
    name: item.name,
    kind: item.kind,
    location: {
      filePath: toNodeModulesRelativePath(item.filePath, nodeModulesRoot),
      line: item.line,
      character: item.character,
    },
    signature: item.signature,
    documentation: item.documentation,
    isReExport: item.isReExport,
  }
}

function flattenDocumentSymbols(
  symbols: DocumentSymbol[],
  filePath: string,
  parents: string[] = [],
): SymbolSummary[] {
  const output: SymbolSummary[] = []
  for (const symbol of symbols) {
    const symbolPath = [...parents, symbol.name]
    output.push({
      name: symbol.name,
      kind: formatSymbolKind(symbol.kind),
      location: {
        filePath,
        line: symbol.range.start.line + 1,
        character: symbol.range.start.character,
        range: symbol.range,
      },
      containerName: parents[parents.length - 1],
      symbolPath,
    })
    if (symbol.children?.length) {
      output.push(...flattenDocumentSymbols(symbol.children, filePath, symbolPath))
    }
  }
  return output
}

function workspaceSymbolToSummary(symbol: SymbolInfo): SymbolSummary {
  return {
    name: symbol.name,
    kind: formatSymbolKind(symbol.kind),
    location: locationToRef(symbol.location),
    containerName: symbol.containerName,
    symbolPath: symbol.containerName ? [symbol.containerName, symbol.name] : [symbol.name],
  }
}

export const lsp_discover: ToolDefinition = tool({
  description:
    "Discover project or package APIs when you do not yet know which symbol to inspect. " +
    "Use with filePath for file/workspace symbols, or packageName to list package exports. " +
    "Returns grouped symbols and suggests lsp_inspect for detailed usage context.",
  args: {
    filePath: tool.schema.string().optional(),
    packageName: tool.schema
      .union([tool.schema.string(), tool.schema.array(tool.schema.string())])
      .optional()
      .describe("Package name (exact), array, glob, or regex literal '/.../'"),
    workspaceRoot: tool.schema.string().optional(),
    query: tool.schema.string().optional(),
    kinds: tool.schema
      .array(
        tool.schema.enum([
          "class",
          "interface",
          "type",
          "enum",
          "function",
          "variable",
          "namespace",
        ]),
      )
      .optional(),
    limit: tool.schema.number().min(1).max(5000).optional(),
    maxPackages: tool.schema.number().min(1).max(500).optional(),
  },
  execute: async (args, _context) => {
    try {
      const limit = args.limit ?? 200

      if (args.packageName) {
        await ensureLspServersInstalled()
        const workspaceRoot = toWorkspaceRoot(args.workspaceRoot)
        const packages = expandPackageNames(args.packageName, workspaceRoot, args.maxPackages ?? 20)
        if (packages.length === 0) {
          return errorResult("lsp_discover", `No packages matched "${Array.isArray(args.packageName) ? args.packageName.join(", ") : args.packageName}"`)
        }

        const packageResults: PackageDiscovery[] = []
        const warnings: string[] = []
        let total = 0
        let shown = 0
        for (const pkg of packages) {
          const resolved = resolvePackage(pkg, workspaceRoot)
          if (!resolved) {
            warnings.push(`[${pkg}] package root or .d.ts entry not resolved`)
            continue
          }
          const items = filterPackageExports(
            scanDtsExports(resolved.entries, { includeReExports: true, packageRoot: resolved.packageRoot }),
            { query: args.query, kinds: args.kinds as KindFilter[] | undefined },
          ).sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
          const limited = items.slice(0, limit)
          total += items.length
          shown += limited.length
          packageResults.push({
            packageName: pkg,
            packageRoot: resolved.packageRoot,
            nodeModulesRoot: resolved.nodeModulesRoot,
            symbols: limited.map((item) => dtsExportToSummary(item, resolved.nodeModulesRoot)),
            total: items.length,
            shown: limited.length,
          })
        }
        return okResult<DiscoverData>(
          "lsp_discover",
          `Discovered ${shown}/${total} package symbol(s).`,
          {
            input: {
              packageName: args.packageName,
              query: args.query,
              kinds: args.kinds as string[] | undefined,
            },
            packages: packageResults,
            total,
            shown,
          },
          {
            warnings,
            truncated: shown < total,
            hints: shown > 0 ? ["Use lsp_inspect with packageName and symbolName for detailed usage context."] : [],
          },
        )
      }

      if (!args.filePath) {
        return errorResult("lsp_discover", "provide either packageName, or filePath")
      }

      if (args.query) {
        const result = await withLspClient(args.filePath, async (client) => {
          return (await client.workspaceSymbols(args.query!)) as SymbolInfo[] | null
        })
        if (!result || result.length === 0) {
          return okResult<DiscoverData>("lsp_discover", "No symbols found.", {
            input: { filePath: args.filePath, query: args.query },
            workspaceSymbols: [],
            total: 0,
            shown: 0,
          })
        }
        const limited = result.slice(0, Math.min(limit, DEFAULT_MAX_SYMBOLS))
        return okResult<DiscoverData>(
          "lsp_discover",
          `Discovered ${limited.length}/${result.length} workspace symbol(s).`,
          {
            input: { filePath: args.filePath, query: args.query },
            workspaceSymbols: limited.map(workspaceSymbolToSummary),
            total: result.length,
            shown: limited.length,
          },
          {
            truncated: limited.length < result.length,
            hints: ["Use lsp_inspect with the source position of the target symbol."],
          },
        )
      }

      const result = await withLspClient(args.filePath, async (client) => {
        return (await client.documentSymbols(args.filePath!)) as DocumentSymbol[] | SymbolInfo[] | null
      })
      if (!result || result.length === 0) {
        return okResult<DiscoverData>("lsp_discover", "No symbols found.", {
          input: { filePath: args.filePath },
          fileSymbols: [],
          total: 0,
          shown: 0,
        })
      }

      const allSymbols = "range" in result[0]
        ? flattenDocumentSymbols(result as DocumentSymbol[], args.filePath)
        : (result as SymbolInfo[]).map(workspaceSymbolToSummary)
      const symbols = allSymbols.slice(0, Math.min(limit, DEFAULT_MAX_SYMBOLS))
      return okResult<DiscoverData>(
        "lsp_discover",
        `Discovered ${symbols.length}/${allSymbols.length} file symbol(s).`,
        {
          input: { filePath: args.filePath },
          fileSymbols: symbols,
          total: allSymbols.length,
          shown: symbols.length,
        },
        {
          truncated: symbols.length < allSymbols.length,
          hints: ["Use lsp_inspect with filePath + line + character for details."],
        },
      )
    } catch (e) {
      return errorResult("lsp_discover", e instanceof Error ? e.message : String(e))
    }
  },
})
