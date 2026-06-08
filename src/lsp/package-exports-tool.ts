import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool"

import { withLspClient } from "./lsp-client-wrapper"
import { formatHover } from "./lsp-formatters"
import {
  expandPackageNames,
  resolvePackage,
  scanDtsExports,
  toWorkspaceRoot,
  toNodeModulesRelativePath,
} from "./package-resolution"
import type { DtsExport, UnifiedSymbolKind } from "./package-resolution"
import { ensureLspServersInstalled } from "./server-auto-installer"
import { errorResult, okResult, type LocationRef } from "./tool-result"
import type { Hover } from "./types"

type Strategy = "auto" | "lsp-completion" | "probe" | "dts-scan"

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

interface PackageExportsData {
  input: {
    packageName: string | string[]
    query?: string
    kinds?: string[]
    includeReExports?: boolean
  }
  packages: Array<{
    packageName: string
    groupLabel?: string
    packageRoot: string
    nodeModulesRoot: string | null
    nodeModulesRootLabel?: string
    symbols: Array<{
      name: string
      kind: string
      displayName: string
      definition: string
      location: LocationRef
      signature?: string
      documentation?: string
      hoverText?: string
      isReExport: boolean
    }>
    total: number
    shown: number
  }>
  total: number
  shown: number
}

function filterExports(
  items: DtsExport[],
  opts: {
    kinds?: KindFilter[]
    query?: string
    includeReExports?: boolean
  },
): DtsExport[] {
  let list = items

  const knownNames = new Set(list.filter((e) => e.kind !== "Unknown").map((e) => e.name))
  list = list.filter((e) => e.kind !== "Unknown" || !knownNames.has(e.name))

  if (opts.includeReExports === false) {
    list = list.filter((e) => !e.isReExport)
  }

  if (opts.kinds && opts.kinds.length > 0) {
    const allow = new Set<UnifiedSymbolKind>()
    for (const k of opts.kinds) {
      for (const mapped of KIND_FILTER_MAP[k] ?? []) {
        allow.add(mapped)
      }
    }
    list = list.filter((e) => allow.has(e.kind))
  }

  if (opts.query) {
    const q = opts.query.toLowerCase()
    list = list.filter((e) => e.name.toLowerCase().includes(q))
  }

  return list
}

function formatFallbackHover(item: DtsExport): string | undefined {
  const parts: string[] = []
  if (item.signature) {
    parts.push("```ts\n" + item.signature + "\n```")
  }
  if (item.documentation) {
    parts.push(item.documentation)
  }
  const body = parts.join("\n\n").trim()
  return body || undefined
}

async function tryLspHoverForExport(item: DtsExport): Promise<string | undefined> {
  const hover = await withLspClient(item.filePath, async (client) => {
    return (await client.hover(item.filePath, item.line, item.character)) as Hover | null
  })
  const body = formatHover(hover)
  return body !== "No hover information found" ? body : undefined
}

async function enrichExportsWithHover(
  items: DtsExport[],
  strategy: Strategy,
): Promise<Array<DtsExport & { hoverText?: string }>> {
  const output = items.map((item) => ({ ...item, hoverText: formatFallbackHover(item) }))
  if (strategy === "dts-scan") return output

  const concurrency = 5
  for (let i = 0; i < output.length; i += concurrency) {
    const batch = output.slice(i, i + concurrency)
    await Promise.all(
      batch.map(async (item) => {
        try {
          const hoverText = await tryLspHoverForExport(item)
          if (hoverText) item.hoverText = hoverText
        } catch {}
      }),
    )
  }

  return output
}

function formatExportBlock(e: DtsExport & { hoverText?: string }, nodeModulesRoot: string | null): string {
  const tag = e.isReExport ? " [re-export]" : ""
  const lines = [
    `${e.name} (${e.kind})${tag}`,
    `Definition: ${toNodeModulesRelativePath(e.filePath, nodeModulesRoot)}:${e.line}:${e.character}`,
  ]
  if (e.hoverText) {
    lines.push("---")
    lines.push(e.hoverText)
  }
  return lines.join("\n")
}

async function collectPackageExports(
  pkg: string,
  workspaceRoot: string,
): Promise<{ pkg: string; items: DtsExport[]; packageRoot?: string; nodeModulesRoot?: string | null; error?: string }> {
  const resolved = resolvePackage(pkg, workspaceRoot)
  if (!resolved) {
    return { pkg, items: [], error: "package root not resolved" }
  }
  const items = scanDtsExports(resolved.entries, { includeReExports: true, packageRoot: resolved.packageRoot })
  return {
    pkg,
    items,
    packageRoot: resolved.packageRoot,
    nodeModulesRoot: resolved.nodeModulesRoot,
  }
}

export const lsp_package_exports: ToolDefinition = tool({
  description:
    "List ALL publicly exported symbols (classes, interfaces, types, enums, functions, variables, namespaces) of one or more installed packages. " +
    "Follows re-export chains (`export { X } from './impl'`) and includes type-only exports. " +
    "Use when: 'what APIs does @sar-engine/core expose?', 'list every export of packages under @scope/*', 'find exports matching Texture* in a package'. " +
    "packageName accepts: exact name, array of names, glob ('@scope/*') or regex literal ('/^@scope\\//'). " +
    "Optional filters: kinds (narrow to class/interface/function/...), query (substring match on export name), limit, groupByPackage. " +
    "Returns each visible export with its declaration path relative to the resolved node_modules root and, when possible, full hover/JSDoc information. " +
    "Prefer this over ast_grep_search in node_modules — it is symbol-aware and won't miss re-exports or type exports. " +
    "Not for: locating a specific symbol's declaration position (use lsp_package_symbol), or workspace-wide usage search (use lsp_find_references).",
  args: {
    packageName: tool.schema
      .union([
        tool.schema.string(),
        tool.schema.array(tool.schema.string()),
      ])
      .describe("Package name (exact), array, glob, or regex literal"),
    workspaceRoot: tool.schema.string().optional(),
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
    query: tool.schema.string().optional().describe("Case-insensitive substring filter on symbol name"),
    limit: tool.schema.number().min(1).max(5000).optional(),
    includeReExports: tool.schema.boolean().optional(),
    strategy: tool.schema
      .enum(["auto", "lsp-completion", "probe", "dts-scan"])
      .optional(),
    maxPackages: tool.schema.number().min(1).max(500).optional(),
    groupByPackage: tool.schema.boolean().optional(),
  },
  execute: async (args, _context) => {
    try {
      await ensureLspServersInstalled()
      const workspaceRoot = toWorkspaceRoot(args.workspaceRoot)
      const strategy: Strategy = (args.strategy as Strategy | undefined) ?? "auto"
      const limit = args.limit ?? 200
      const maxPackages = args.maxPackages ?? 20
      const groupByPackage = args.groupByPackage ?? true

      const packages = expandPackageNames(args.packageName, workspaceRoot, maxPackages)
      if (packages.length === 0) {
        return errorResult("lsp_package_exports", `No packages matched "${Array.isArray(args.packageName) ? args.packageName.join(", ") : args.packageName}"`)
      }

      const warnings: string[] = []
      const collected = [] as Array<{
        pkg: string
        items: DtsExport[]
        packageRoot: string
        nodeModulesRoot: string | null
      }>

      const concurrency = 5
      for (let i = 0; i < packages.length; i += concurrency) {
        const batch = packages.slice(i, i + concurrency)
        const results = await Promise.all(
          batch.map(async (pkg) => {
            try {
              return await collectPackageExports(pkg, workspaceRoot)
            } catch (e) {
              return {
                pkg,
                items: [] as DtsExport[],
                packageRoot: undefined,
                nodeModulesRoot: undefined,
                error: e instanceof Error ? e.message : String(e),
              }
            }
          }),
        )
        for (const r of results) {
          if (r.error) warnings.push(`[${r.pkg}] ${r.error}`)
          const filtered = filterExports(r.items, {
            kinds: args.kinds as KindFilter[] | undefined,
            query: args.query,
            includeReExports: args.includeReExports,
          })
          if (filtered.length > 0 && r.packageRoot) {
            collected.push({
              pkg: r.pkg,
              items: filtered,
              packageRoot: r.packageRoot,
              nodeModulesRoot: r.nodeModulesRoot ?? null,
            })
          }
        }
      }

      if (collected.length === 0) {
        const base = `No exports found for "${Array.isArray(args.packageName) ? args.packageName.join(", ") : args.packageName}"`
        return okResult<PackageExportsData>(
          "lsp_package_exports",
          base,
          {
            input: {
              packageName: args.packageName,
              query: args.query,
              kinds: args.kinds as string[] | undefined,
              includeReExports: args.includeReExports,
            },
            packages: [],
            total: 0,
            shown: 0,
          },
          { warnings },
        )
      }

      collected.sort((a, b) => a.pkg.localeCompare(b.pkg))
      for (const group of collected) {
        group.items.sort((a, b) => a.name.localeCompare(b.name))
      }

      const totalAll = collected.reduce((sum, g) => sum + g.items.length, 0)

      const packageResults: PackageExportsData["packages"] = []
      let shown = 0

      if (groupByPackage) {
        let remaining = limit
        for (const group of collected) {
          if (remaining <= 0) break
          const take = Math.min(group.items.length, remaining)
          const visible = await enrichExportsWithHover(group.items.slice(0, take), strategy)
          packageResults.push({
            packageName: group.pkg,
            groupLabel: `=== ${toNodeModulesRelativePath(group.packageRoot, group.nodeModulesRoot)}`,
            packageRoot: group.packageRoot,
            nodeModulesRoot: group.nodeModulesRoot,
            nodeModulesRootLabel: group.nodeModulesRoot ? `Node modules root: ${group.nodeModulesRoot}` : undefined,
            total: group.items.length,
            shown: visible.length,
            symbols: visible.map((item) => ({
              name: item.name,
              kind: item.kind,
              displayName: `${item.name} (${item.kind})`,
              definition: `Definition: ${toNodeModulesRelativePath(item.filePath, group.nodeModulesRoot)}:${item.line}:${item.character}`,
              location: {
                filePath: toNodeModulesRelativePath(item.filePath, group.nodeModulesRoot),
                line: item.line,
                character: item.character,
              },
              signature: item.signature,
              documentation: item.documentation,
              hoverText: item.hoverText,
              isReExport: item.isReExport,
            })),
          })
          shown += visible.length
          remaining -= take
        }
      } else {
        const flat: Array<{ item: DtsExport; nodeModulesRoot: string | null }> = []
        for (const g of collected) {
          for (const item of g.items) flat.push({ item, nodeModulesRoot: g.nodeModulesRoot })
        }
        flat.sort((a, b) => a.item.name.localeCompare(b.item.name) || a.item.filePath.localeCompare(b.item.filePath))
        const take = Math.min(flat.length, limit)
        const visible = await enrichExportsWithHover(
          flat.slice(0, take).map(({ item }) => item),
          strategy,
        )
        shown = visible.length
        packageResults.push({
          packageName: "flat",
          packageRoot: "",
          nodeModulesRoot: null,
          total: flat.length,
          shown: visible.length,
          symbols: visible.map((item, i) => {
            const root = flat[i]?.nodeModulesRoot ?? null
            return {
              name: item.name,
              kind: item.kind,
              displayName: `${item.name} (${item.kind})`,
              definition: `Definition: ${toNodeModulesRelativePath(item.filePath, root)}:${item.line}:${item.character}`,
              location: {
                filePath: toNodeModulesRelativePath(item.filePath, root),
                line: item.line,
                character: item.character,
              },
              signature: item.signature,
              documentation: item.documentation,
              hoverText: item.hoverText,
              isReExport: item.isReExport,
            }
          }),
        })
      }

      return okResult<PackageExportsData>(
        "lsp_package_exports",
        `Found ${totalAll} export(s), showing ${shown}.`,
        {
          input: {
            packageName: args.packageName,
            query: args.query,
            kinds: args.kinds as string[] | undefined,
            includeReExports: args.includeReExports,
          },
          packages: packageResults,
          total: totalAll,
          shown,
        },
        {
          warnings,
          truncated: shown < totalAll,
          hints: shown < totalAll ? ["Increase limit or narrow kinds/query for more exports."] : [],
        },
      )
    } catch (e) {
      return errorResult("lsp_package_exports", e instanceof Error ? e.message : String(e))
    }
  },
})
