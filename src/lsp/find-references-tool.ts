import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool"

import { DEFAULT_MAX_REFERENCES } from "./constants"
import { formatLocation } from "./lsp-formatters"
import { withLspClient } from "./lsp-client-wrapper"
import {
  resolvePackageSymbolLocations,
  toWorkspaceRoot,
} from "./package-resolution"
import { ensureLspServersInstalled } from "./server-auto-installer"
import type { Location } from "./types"

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
          return "Error: symbolName is required when packageName is provided"
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
          return `Symbol "${args.symbolName}" not found in package(s) matching: ${names}`
        }

        const notePrefix =
          args.filePath || args.line !== undefined || args.character !== undefined
            ? "Note: filePath/line/character ignored because packageName was provided.\n\n"
            : ""

        const blocks: string[] = []
        const includeDeclaration = args.includeDeclaration ?? true

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
            blocks.push(
              `=== ${loc.pkg} :: ${args.symbolName} ===\n` +
                `Error: ${e instanceof Error ? e.message : String(e)}`,
            )
            continue
          }

          const header = `=== ${loc.pkg} :: ${args.symbolName} ===`
          if (!refs || refs.length === 0) {
            blocks.push(`${header}\nNo references found`)
            continue
          }

          const total = refs.length
          const truncated = total > DEFAULT_MAX_REFERENCES
          const limited = truncated ? refs.slice(0, DEFAULT_MAX_REFERENCES) : refs
          const lines = limited.map(formatLocation)
          const prefix = truncated
            ? `Found ${total} references (showing first ${DEFAULT_MAX_REFERENCES}):`
            : `Found ${total} reference(s):`
          blocks.push(`${header}\n${prefix}\n${lines.join("\n")}`)
        }

        return notePrefix + blocks.join("\n\n")
      }

      if (!args.filePath || args.line === undefined || args.character === undefined) {
        return "Error: provide either packageName + symbolName, or filePath + line + character"
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
        return "No references found"
      }

      const total = result.length
      const truncated = total > DEFAULT_MAX_REFERENCES
      const limited = truncated ? result.slice(0, DEFAULT_MAX_REFERENCES) : result
      const lines = limited.map(formatLocation)
      if (truncated) {
        lines.unshift(`Found ${total} references (showing first ${DEFAULT_MAX_REFERENCES}):`)
      }
      return lines.join("\n")
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`
    }
  },
})
