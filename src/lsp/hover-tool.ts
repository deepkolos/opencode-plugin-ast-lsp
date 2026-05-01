import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool"

import { formatHover, formatLocation } from "./lsp-formatters"
import { withLspClient } from "./lsp-client-wrapper"
import {
  resolvePackageSymbolLocations,
  toWorkspaceRoot,
  toNodeModulesRelativePath,
} from "./package-resolution"
import { ensureLspServersInstalled } from "./server-auto-installer"
import type { Hover, Location, LocationLink } from "./types"

function firstDefinitionLocation(
  definition: unknown,
): Location | LocationLink | null {
  if (!definition) return null
  if (Array.isArray(definition)) {
    return (definition[0] as Location | LocationLink | undefined) ?? null
  }
  return definition as Location | LocationLink
}

function formatHoverBlock(
  hover: Hover | null,
  opts: {
    source?: string
    definition?: string
  } = {},
): string {
  const lines: string[] = []
  if (opts.source) lines.push(`Source: ${opts.source}`)
  if (opts.definition) lines.push(`Definition: ${opts.definition}`)
  lines.push("---")
  lines.push(formatHover(hover))
  return lines.join("\n")
}

export const lsp_hover: ToolDefinition = tool({
  description:
    "Show documentation, signature and type for a symbol (JSDoc, @deprecated, generic params, return type). " +
    "Use when: 'what is the signature of X?', 'does this have a doc comment?', 'what type does Y return?'. " +
    "Two input modes: (1) classic filePath + line + character for a symbol already present in source, or " +
    "(2) packageName + symbolName to hover a declaration inside an installed package WITHOUT needing an existing usage. " +
    "packageName supports exact name, array, glob (e.g. '@scope/*'), or regex literal '/.../'. " +
    "Not for: listing all exports of a package (use lsp_package_exports), jumping to source (use lsp_goto_definition), " +
    "finding usages (use lsp_find_references), or free-text code search (use ast_grep_search).",
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

        const noteLines: string[] = []
        if (args.filePath || args.line !== undefined || args.character !== undefined) {
          noteLines.push(
            "Note: filePath/line/character ignored because packageName was provided.",
          )
        }

        const blocks: string[] = []
        for (const loc of locations) {
          try {
            const hover = await withLspClient(loc.filePath, async (client) => {
              return (await client.hover(loc.filePath, loc.line, loc.character)) as Hover | null
            })
            const source = loc.nodeModulesRoot
              ? toNodeModulesRelativePath(loc.filePath, loc.nodeModulesRoot)
              : loc.filePath
            blocks.push(
              `${loc.pkg} :: ${args.symbolName}\n` +
                formatHoverBlock(hover, {
                  source: `${source}:${loc.line}:${loc.character}`,
                  definition: `${source}:${loc.line}:${loc.character}`,
                }),
            )
          } catch (e) {
            blocks.push(
              `${loc.pkg} :: ${args.symbolName}\n` +
                `Source: ${loc.filePath}:${loc.line}:${loc.character}\n` +
                `---\nError: ${e instanceof Error ? e.message : String(e)}`,
            )
          }
        }

        const note = noteLines.length ? noteLines.join("\n") + "\n\n" : ""
        return note + blocks.join("\n\n")
      }

      if (!args.filePath || args.line === undefined || args.character === undefined) {
        return "Error: provide either packageName + symbolName, or filePath + line + character"
      }

      const result = await withLspClient(args.filePath, async (client) => {
        const hover = (await client.hover(args.filePath!, args.line!, args.character!)) as Hover | null
        const definition = firstDefinitionLocation(
          await client.definition(args.filePath!, args.line!, args.character!),
        )
        return { hover, definition }
      })

      return formatHoverBlock(result.hover, {
        source: `${args.filePath}:${args.line}:${args.character}`,
        definition: result.definition ? formatLocation(result.definition) : undefined,
      })
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`
    }
  },
})
