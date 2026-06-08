import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool"

import { DEFAULT_MAX_REFERENCES } from "./constants"
import { withLspClient } from "./lsp-client-wrapper"
import {
  resolvePackageSymbolLocations,
  toWorkspaceRoot,
} from "./package-resolution"
import { ensureLspServersInstalled } from "./server-auto-installer"
import { errorResult, locationToRef, okResult, type LocationRef } from "./tool-result"
import type { Location } from "./types"

interface ReferencesData {
  input: {
    filePath?: string
    line?: number
    character?: number
    packageName?: string | string[]
    symbolName?: string
    includeDeclaration: boolean
  }
  references: Array<{
    packageName?: string
    label?: string
    locations: LocationRef[]
    total: number
    shown: number
  }>
  total: number
  shown: number
}

export const lsp_find_references: ToolDefinition = tool({
  description:
    "Find ALL usages of a symbol across the workspace (semantic, not textual — handles aliasing, shadowing, re-imports). " +
    "Use when: 'who calls this function?', 'impact analysis before removing/deprecating an export', 'every place that uses Texture2D'. " +
    "Two input modes: (1) classic filePath + line + character on a symbol already present in source, or " +
    "(2) packageName + symbolName to find workspace-wide references to a symbol declared inside an installed package (no existing usage point needed). " +
    "packageName supports exact name, array, glob (e.g. '@scope/*'), or regex literal '/.../'. " +
    "Prefer this over ast_grep_search when you need semantic accuracy (no false matches from same-name locals/strings/comments). " +
    "Not for: seeing the definition itself (use lsp_goto_definition), reading docs (use lsp_hover), or renaming (use lsp_rename).",
  args: {
    filePath: tool.schema.string().optional(),
    line: tool.schema.number().min(1).optional().describe("1-based"),
    character: tool.schema.number().min(0).optional().describe("0-based"),
    includeDeclaration: tool.schema.boolean().optional().describe("Include the declaration itself"),
    packageName: tool.schema
      .union([tool.schema.string(), tool.schema.array(tool.schema.string())])
      .optional()
      .describe("Package name (exact), array, glob, or regex literal '/.../'"),
    symbolName: tool.schema
      .string()
      .optional()
      .describe("Required together with packageName"),
    workspaceRoot: tool.schema.string().optional(),
    maxPackages: tool.schema.number().min(1).max(500).optional(),
  },
  execute: async (args, _context) => {
    try {
      if (args.packageName) {
        if (!args.symbolName) {
          return errorResult("lsp_find_references", "symbolName is required when packageName is provided")
        }
        await ensureLspServersInstalled()
        const workspaceRoot = toWorkspaceRoot(args.workspaceRoot)
        const maxPackages = args.maxPackages ?? 20
        const locations = resolvePackageSymbolLocations(
          args.packageName,
          args.symbolName,
          workspaceRoot,
          maxPackages,
        )
        if (locations.length === 0) {
          const names = Array.isArray(args.packageName)
            ? args.packageName.join(", ")
            : args.packageName
          return errorResult("lsp_find_references", `Symbol "${args.symbolName}" not found in package(s) matching: ${names}`)
        }

        const warnings: string[] = []
        const includeDeclaration = args.includeDeclaration ?? true
        const references: ReferencesData["references"] = []
        let totalAll = 0
        let shownAll = 0

        for (const loc of locations) {
          let refs: Location[] | null = null
          try {
            refs = await withLspClient(loc.filePath, async (client) => {
              return (await client.references(
                loc.filePath,
                loc.line,
                loc.character,
                includeDeclaration,
              )) as Location[] | null
            })
          } catch (e) {
            warnings.push(`[${loc.pkg}] ${e instanceof Error ? e.message : String(e)}`)
            continue
          }

          if (!refs || refs.length === 0) {
            references.push({ packageName: loc.pkg, label: `=== ${loc.pkg} :: ${args.symbolName} ===`, locations: [], total: 0, shown: 0 })
            continue
          }

          const total = refs.length
          const truncated = total > DEFAULT_MAX_REFERENCES
          const limited = truncated ? refs.slice(0, DEFAULT_MAX_REFERENCES) : refs
          totalAll += total
          shownAll += limited.length
          references.push({
            packageName: loc.pkg,
            label: `=== ${loc.pkg} :: ${args.symbolName} ===`,
            locations: limited.map(locationToRef),
            total,
            shown: limited.length,
          })
        }

        if (args.filePath || args.line !== undefined || args.character !== undefined) {
          warnings.push("filePath/line/character ignored because packageName was provided.")
        }

        return okResult<ReferencesData>(
          "lsp_find_references",
          `Found ${totalAll} reference(s), showing ${shownAll}.`,
          {
            input: {
              packageName: args.packageName,
              symbolName: args.symbolName,
              includeDeclaration,
            },
            references,
            total: totalAll,
            shown: shownAll,
          },
          {
            warnings,
            truncated: shownAll < totalAll,
          },
        )
      }

      if (!args.filePath || args.line === undefined || args.character === undefined) {
        return errorResult("lsp_find_references", "provide either packageName + symbolName, or filePath + line + character")
      }

      const result = await withLspClient(args.filePath, async (client) => {
        return (await client.references(
          args.filePath!,
          args.line!,
          args.character!,
          args.includeDeclaration ?? true,
        )) as Location[] | null
      })

      if (!result || result.length === 0) {
        return okResult<ReferencesData>("lsp_find_references", "No references found.", {
          input: {
            filePath: args.filePath,
            line: args.line,
            character: args.character,
            includeDeclaration: args.includeDeclaration ?? true,
          },
          references: [],
          total: 0,
          shown: 0,
        })
      }

      const total = result.length
      const truncated = total > DEFAULT_MAX_REFERENCES
      const limited = truncated ? result.slice(0, DEFAULT_MAX_REFERENCES) : result
      return okResult<ReferencesData>(
        "lsp_find_references",
        `Found ${total} reference(s), showing ${limited.length}.`,
        {
          input: {
            filePath: args.filePath,
            line: args.line,
            character: args.character,
            includeDeclaration: args.includeDeclaration ?? true,
          },
          references: [{ locations: limited.map(locationToRef), total, shown: limited.length }],
          total,
          shown: limited.length,
        },
        { truncated },
      )
    } catch (e) {
      return errorResult("lsp_find_references", e instanceof Error ? e.message : String(e))
    }
  },
})
