import { resolve } from "path"

import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool"

import { DEFAULT_MAX_DIAGNOSTICS } from "./constants"
import { aggregateDiagnosticsForDirectoryStructured } from "./directory-diagnostics"
import { inferExtensionFromDirectory } from "./infer-extension"
import { filterDiagnosticsBySeverity, formatSeverity } from "./lsp-formatters"
import { isDirectoryPath, withLspClient } from "./lsp-client-wrapper"
import { errorResult, okResult } from "./tool-result"
import type { Diagnostic } from "./types"

interface DiagnosticInfo {
  location: {
    filePath?: string
    range: Diagnostic["range"]
  }
  severity: string
  source?: string
  code?: string | number
  message: string
}

interface DiagnosticsData {
  target: string
  label: string
  diagnostics: DiagnosticInfo[]
  total: number
  shown: number
}

function toDiagnosticInfo(diagnostic: Diagnostic, filePath?: string): DiagnosticInfo {
  return {
    location: { filePath, range: diagnostic.range },
    severity: formatSeverity(diagnostic.severity),
    source: diagnostic.source,
    code: diagnostic.code,
    message: diagnostic.message,
  }
}

export const lsp_diagnostics: ToolDefinition = tool({
  description:
    "Fetch type-checker / linter diagnostics (errors, warnings, hints) for a file or a directory before building. " +
    "Use when: 'type-check this file', 'any errors under src/?', 'validate my change compiles'. " +
    "Accepts a directory and aggregates diagnostics for all supported source files under it. " +
    "Not for: inspecting installed packages (.d.ts inside node_modules rarely has actionable diagnostics; use lsp_discover / lsp_inspect to explore APIs instead), " +
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
        const result = await aggregateDiagnosticsForDirectoryStructured(absPath, extension, args.severity)
        return okResult<DiagnosticsData>(
          "lsp_diagnostics",
          `Found ${result.total} diagnostic(s), showing ${result.shown}.`,
          {
            target: absPath,
            label: `Directory: ${absPath}`,
            diagnostics: result.diagnostics.map(({ filePath, diagnostic }) => toDiagnosticInfo(diagnostic, filePath)),
            total: result.total,
            shown: result.shown,
          },
          {
            warnings: result.fileErrors.map(({ file, error }) => `${file}: ${error}`),
            truncated: result.truncated,
          },
        )
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
        return okResult<DiagnosticsData>("lsp_diagnostics", "No diagnostics found.", {
          target: absPath,
          label: `File: ${absPath}`,
          diagnostics: [],
          total: 0,
          shown: 0,
        })
      }

      const total = diagnostics.length
      const truncated = total > DEFAULT_MAX_DIAGNOSTICS
      const limited = truncated ? diagnostics.slice(0, DEFAULT_MAX_DIAGNOSTICS) : diagnostics
      return okResult<DiagnosticsData>(
        "lsp_diagnostics",
        `Found ${total} diagnostic(s), showing ${limited.length}.`,
        {
          target: absPath,
          label: `File: ${absPath}`,
          diagnostics: limited.map((diagnostic) => toDiagnosticInfo(diagnostic, absPath)),
          total,
          shown: limited.length,
        },
        { truncated },
      )
    } catch (e) {
      return errorResult("lsp_diagnostics", e instanceof Error ? e.message : String(e))
    }
  },
})
