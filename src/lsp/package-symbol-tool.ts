import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool"

import { withLspClient } from "./lsp-client-wrapper"
import { formatHover } from "./lsp-formatters"
import {
  expandPackageNames,
  findDtsSymbol,
  resolvePackage,
  toWorkspaceRoot,
  toNodeModulesRelativePath,
} from "./package-resolution"
import type { DtsExport } from "./package-resolution"
import { ensureLspServersInstalled } from "./server-auto-installer"
import type { Hover } from "./types"

type Strategy = "auto" | "lsp-completion" | "probe" | "dts-scan"

interface PackageHit {
  pkg: string
  match: DtsExport
  nodeModulesRoot: string | null
  hoverText?: string
}

async function locateInPackage(
  pkg: string,
  symbolName: string,
  workspaceRoot: string,
  strategy: Strategy,
  includeHover: boolean,
): Promise<PackageHit | null> {
  const resolved = resolvePackage(pkg, workspaceRoot)
  if (!resolved) return null

  const match = findDtsSymbol(resolved.entries, symbolName)
  if (!match) return null

  let hoverText: string | undefined
  if (includeHover && strategy !== "dts-scan") {
    try {
      hoverText = await tryLspHoverForLocation(match.filePath, match.line, match.character)
    } catch {}
  }

  if (!hoverText) {
    hoverText = formatFallbackHover(match)
  }

  return { pkg, match, nodeModulesRoot: resolved.nodeModulesRoot, hoverText }
}

async function tryLspHoverForLocation(
  filePath: string,
  line: number,
  character: number,
): Promise<string | undefined> {
  const hover = await withLspClient(filePath, async (client) => {
    return (await client.hover(filePath, line, character)) as Hover | null
  })
  const body = formatHover(hover)
  return body !== "No hover information found" ? body : undefined
}

function formatFallbackHover(match: DtsExport): string | undefined {
  const parts: string[] = []
  if (match.signature) {
    parts.push("```ts\n" + match.signature + "\n```")
  }
  if (match.documentation) {
    parts.push(match.documentation)
  }
  const body = parts.join("\n\n").trim()
  return body || undefined
}

function formatHit(hit: PackageHit): string {
  const { match, nodeModulesRoot, hoverText } = hit
  const lines: string[] = []
  if (nodeModulesRoot) {
    lines.push(`Node modules root: ${nodeModulesRoot}`)
  }
  lines.push(
    `Definition: ${toNodeModulesRelativePath(match.filePath, nodeModulesRoot)}:${match.line}:${match.character}`,
  )
  lines.push(`Kind: ${match.kind}`)
  if (hoverText) {
    lines.push("---")
    lines.push(hoverText)
  }
  return lines.join("\n")
}

export const lsp_package_symbol: ToolDefinition = tool({
  description:
    "Locate a TypeScript/JavaScript type or value declaration inside an installed package by package name + symbol name, " +
    "without requiring the symbol to be used anywhere in the project. " +
    "Returns declaration location and (when possible) hover documentation. " +
    "Use when: 'show me where Texture2D is declared in @sar-engine/core', 'I saw X mentioned in docs — locate it'. " +
    "Supports exact package name, array of names, glob pattern (e.g. '@scope/*') or regex literal (e.g. '/^@scope\\//'). " +
    "Prefer this over lsp_goto_definition when there is no existing usage of the symbol in your workspace. " +
    "Not for: listing every export of a package (use lsp_package_exports), or free-text code search (use ast_grep_search).",
  args: {
    packageName: tool.schema
      .union([
        tool.schema.string(),
        tool.schema.array(tool.schema.string()),
      ])
      .describe("Package name (exact), array of names, glob (e.g. '@scope/*'), or regex literal '/.../'"),
    symbolName: tool.schema.string().describe("Exported symbol name to locate (case-sensitive)"),
    workspaceRoot: tool.schema.string().optional(),
    includeHover: tool.schema.boolean().optional(),
    strategy: tool.schema
      .enum(["auto", "lsp-completion", "probe", "dts-scan"])
      .optional(),
    maxPackages: tool.schema.number().min(1).max(500).optional(),
  },
  execute: async (args, _context) => {
    try {
      await ensureLspServersInstalled()
      const workspaceRoot = toWorkspaceRoot(args.workspaceRoot)
      const strategy: Strategy = (args.strategy as Strategy | undefined) ?? "auto"
      const includeHover = args.includeHover ?? true
      const maxPackages = args.maxPackages ?? 20

      const packages = expandPackageNames(args.packageName, workspaceRoot, maxPackages)
      if (packages.length === 0) {
        return `No packages matched "${Array.isArray(args.packageName) ? args.packageName.join(", ") : args.packageName}"`
      }

      const hits: PackageHit[] = []
      const warnings: string[] = []

      const concurrency = 5
      for (let i = 0; i < packages.length; i += concurrency) {
        const batch = packages.slice(i, i + concurrency)
        const results = await Promise.all(
          batch.map(async (pkg) => {
            try {
              return await locateInPackage(pkg, args.symbolName, workspaceRoot, strategy, includeHover)
            } catch (e) {
              warnings.push(`[${pkg}] ${e instanceof Error ? e.message : String(e)}`)
              return null
            }
          }),
        )
        for (const r of results) {
          if (r) hits.push(r)
        }
      }

      if (hits.length === 0) {
        const pkgList = packages.join(", ")
        const base = `Symbol "${args.symbolName}" not found in: ${pkgList}`
        return warnings.length ? `${base}\n\nWarnings:\n${warnings.join("\n")}` : base
      }

      hits.sort((a, b) => a.pkg.localeCompare(b.pkg))
      const header = packages.length > 1 ? `Matched ${hits.length}/${packages.length} package(s):\n` : ""
      const body = hits.map(formatHit).join("\n\n")
      const tail = warnings.length ? `\n\nWarnings:\n${warnings.join("\n")}` : ""
      return header + body + tail
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`
    }
  },
})
