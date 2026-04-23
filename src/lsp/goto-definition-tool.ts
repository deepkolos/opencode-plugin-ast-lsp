import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool"

import { formatLocation } from "./lsp-formatters"
import { withLspClient } from "./lsp-client-wrapper"
import {
  resolvePackageSymbolLocations,
  toWorkspaceRoot,
} from "./package-resolution"
import { ensureLspServersInstalled } from "./server-auto-installer"
import type { Location, LocationLink } from "./types"

export const lsp_goto_definition: ToolDefinition = tool({
  description:
    "Jump to the declaration of a symbol, follows import/re-export chain to the real source file. " +
    "Use when: 'where is X defined?', 'which file does this come from?', 'open the source of this import'. " +
    "Two input modes: (1) classic filePath + line + character for a symbol already present in source, or " +
    "(2) packageName + symbolName to locate a declaration inside an installed package WITHOUT needing an existing usage. " +
    "packageName supports exact name, array, glob (e.g. '@scope/*'), or regex literal '/.../'. " +
    "Not for: reading the signature/docs of the target (use lsp_hover), finding all usages (use lsp_find_references), " +
    "or enumerating a package's exports (use lsp_package_exports).",
  args: {
    filePath: tool.schema.string().optional(),
    line: tool.schema.number().min(1).optional().describe("1-based"),
    character: tool.schema.number().min(0).optional().describe("0-based"),
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

        const lines: string[] = []
        for (const loc of locations) {
          const tsLocations = await withLspClient(loc.filePath, async (client) => {
            return (await client.definition(loc.filePath, loc.line, loc.character)) as
              | Location
              | Location[]
              | LocationLink[]
              | null
          }).catch(() => null)

          if (!tsLocations || (Array.isArray(tsLocations) && tsLocations.length === 0)) {
            lines.push(
              `${loc.pkg} :: ${args.symbolName}\n` +
                `${loc.filePath}:${loc.line}:${loc.character} (declaration)`,
            )
            continue
          }

          const asArray = Array.isArray(tsLocations) ? tsLocations : [tsLocations]
          const formatted = asArray.map(formatLocation).join("\n")
          lines.push(`${loc.pkg} :: ${args.symbolName}\n${formatted}`)
        }

        return notePrefix + lines.join("\n\n")
      }

      if (!args.filePath || args.line === undefined || args.character === undefined) {
        return "Error: provide either packageName + symbolName, or filePath + line + character"
      }

      const result = await withLspClient(args.filePath, async (client) => {
        return (await client.definition(args.filePath!, args.line!, args.character!)) as
          | Location
          | Location[]
          | LocationLink[]
          | null
      })

      if (!result) {
        return "No definition found"
      }

      const locations = Array.isArray(result) ? result : [result]
      if (locations.length === 0) {
        return "No definition found"
      }

      return locations.map(formatLocation).join("\n")
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`
    }
  },
})
