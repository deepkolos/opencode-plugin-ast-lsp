import { resolve } from "path"

import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool"

import { DEFAULT_MAX_DIAGNOSTICS } from "./constants"
import { aggregateDiagnosticsForDirectory } from "./directory-diagnostics"
import { inferExtensionFromDirectory } from "./infer-extension"
import { filterDiagnosticsBySeverity, formatDiagnostic } from "./lsp-formatters"
import { isDirectoryPath, withLspClient } from "./lsp-client-wrapper"
import type { Diagnostic } from "./types"

export const lsp_diagnostics: ToolDefinition = tool({
  description:
    "Fetch type-checker / linter diagnostics (errors, warnings, hints) for a file or a directory before building. " +
    "Use when: 'type-check this file', 'any errors under src/?', 'validate my change compiles'. " +
    "Accepts a directory and aggregates diagnostics for all supported source files under it. " +
    "Not for: inspecting installed packages (.d.ts inside node_modules rarely has actionable diagnostics; use lsp_package_exports / lsp_package_symbol to explore APIs instead), " +
    "or running build scripts / tests (use a shell command instead).",
  args: {
    filePath: tool.schema.string().describe("File or directory path to check diagnostics for"),
    severity: tool.schema
      .enum(["error", "warning", "information", "hint", "all"])
      .optional()
      .describe("Filter by severity level"),
  },
  execute: async (args, _context) => {
    try {
      if (!args.filePath) {
        throw new Error("'filePath' parameter is required.")
      }
      const absPath = resolve(args.filePath)

      if (isDirectoryPath(absPath)) {
        const extension = inferExtensionFromDirectory(absPath)
        if (!extension) {
          throw new Error(`No supported source files found in directory: ${absPath}`)
        }
        return await aggregateDiagnosticsForDirectory(absPath, extension, args.severity)
      }

      const result = await withLspClient(args.filePath, async (client) => {
        return (await client.diagnostics(args.filePath)) as { items?: Diagnostic[] } | Diagnostic[] | null
      })

      let diagnostics: Diagnostic[] = []
      if (result) {
        if (Array.isArray(result)) {
          diagnostics = result
        } else if (result.items) {
          diagnostics = result.items
        }
      }

      diagnostics = filterDiagnosticsBySeverity(diagnostics, args.severity)

      if (diagnostics.length === 0) {
        return "No diagnostics found"
      }

      const total = diagnostics.length
      const truncated = total > DEFAULT_MAX_DIAGNOSTICS
      const limited = truncated ? diagnostics.slice(0, DEFAULT_MAX_DIAGNOSTICS) : diagnostics
      const lines = limited.map(formatDiagnostic)
      if (truncated) {
        lines.unshift(`Found ${total} diagnostics (showing first ${DEFAULT_MAX_DIAGNOSTICS}):`)
      }
      return lines.join("\n")
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`
    }
  },
})
