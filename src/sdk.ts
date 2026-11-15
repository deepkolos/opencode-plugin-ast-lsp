import ts from "typescript"

import {
  expandPackageNames,
  resolvePackage,
  scanDtsExports,
  toNodeModulesRelativePath,
  toWorkspaceRoot,
} from "./lsp/package-resolution"
import type { UnifiedSymbolKind } from "./lsp/package-resolution"

export type PackageSymbolKind = "class" | "interface" | "type" | "enum" | "function" | "variable" | "namespace"

export interface PackageSymbol {
  name: string
  kind: string
  location: { filePath: string; line: number; character: number }
  signature?: string
  documentation?: string
  isReExport?: boolean
}

export interface PackageDiscovery {
  packageName: string
  packageRoot: string
  nodeModulesRoot: string | null
  symbols: PackageSymbol[]
  total: number
  shown: number
}

export interface DiscoverPackagesOptions {
  packageName: string | string[]
  workspaceRoot?: string
  query?: string
  kinds?: PackageSymbolKind[]
  /** Maximum symbols per package, from 1 to 5000. Defaults to 200. */
  limit?: number
  /** Maximum matched packages, from 1 to 500. Defaults to 20. */
  maxPackages?: number
}

export interface DiscoverPackagesResult {
  packages: PackageDiscovery[]
  total: number
  shown: number
  warnings: string[]
  truncated: boolean
}

const kindMap: Record<PackageSymbolKind, UnifiedSymbolKind[]> = {
  class: ["Class"], interface: ["Interface"], type: ["TypeAlias"], enum: ["Enum"],
  function: ["Function"], variable: ["Variable"], namespace: ["Namespace"],
}

/** Discover installed package declarations in Node or Bun, without installing or starting LSP servers. */
export function discoverPackages(options: DiscoverPackagesOptions): DiscoverPackagesResult {
  const limit = options.limit ?? 200
  const maxPackages = options.maxPackages ?? 20
  if (!Number.isInteger(limit) || limit < 1 || limit > 5000) throw new Error("limit must be an integer from 1 to 5000")
  if (!Number.isInteger(maxPackages) || maxPackages < 1 || maxPackages > 500) throw new Error("maxPackages must be an integer from 1 to 500")
  const workspaceRoot = toWorkspaceRoot(options.workspaceRoot)
  const names = expandPackageNames(options.packageName, workspaceRoot, maxPackages)
  if (!names.length) throw new Error(`No packages matched "${Array.isArray(options.packageName) ? options.packageName.join(", ") : options.packageName}"`)
  const query = options.query?.toLowerCase()
  const allowed = options.kinds?.length ? new Set(options.kinds.flatMap(kind => kindMap[kind])) : undefined
  const packages: PackageDiscovery[] = []
  const warnings: string[] = []
  for (const packageName of names) {
    const resolved = resolvePackage(packageName, workspaceRoot)
    if (!resolved) {
      warnings.push(`[${packageName}] package root or .d.ts entry not resolved`)
      continue
    }
    const items = scanDtsExports(resolved.entries, {
      includeReExports: true, packageRoot: resolved.packageRoot, typescript: ts,
    }).filter(item => item.kind !== "Unknown"
      && (!query || item.name.toLowerCase().includes(query))
      && (!allowed || allowed.has(item.kind)))
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
    const symbols = items.slice(0, limit).map(item => ({
      name: item.name, kind: item.kind,
      location: {
        filePath: toNodeModulesRelativePath(item.filePath, resolved.nodeModulesRoot),
        line: item.line, character: item.character,
      },
      signature: item.signature, documentation: item.documentation, isReExport: item.isReExport,
    }))
    packages.push({ packageName, packageRoot: resolved.packageRoot, nodeModulesRoot: resolved.nodeModulesRoot, symbols, total: items.length, shown: symbols.length })
  }
  const total = packages.reduce((sum, item) => sum + item.total, 0)
  const shown = packages.reduce((sum, item) => sum + item.shown, 0)
  return { packages, total, shown, warnings, truncated: shown < total }
}
