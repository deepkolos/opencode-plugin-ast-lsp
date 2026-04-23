import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool"

import { formatPrepareRenameResult } from "./lsp-formatters"
import { withLspClient } from "./lsp-client-wrapper"
import { applyWorkspaceEdit } from "./workspace-edit"
import type { PrepareRenameDefaultBehavior, PrepareRenameResult, WorkspaceEdit } from "./types"

export const lsp_prepare_rename: ToolDefinition = tool({
  description:
    "Pre-flight check BEFORE lsp_rename to confirm the symbol at the given position is renameable and preview its range. " +
    "Use when: about to perform a safe semantic rename and want to verify the cursor is on a valid identifier. " +
    "Not for: simple text substitution (use ast_grep_replace), or renaming symbols declared inside installed packages / node_modules (would pollute dependencies).",
  args: {
    filePath: tool.schema.string(),
    line: tool.schema.number().min(1).describe("1-based"),
    character: tool.schema.number().min(0).describe("0-based"),
  },
  execute: async (args, _context) => {
    try {
      const result = await withLspClient(args.filePath, async (client) => {
        return (await client.prepareRename(args.filePath, args.line, args.character)) as
          | PrepareRenameResult
          | PrepareRenameDefaultBehavior
          | null
      })
      return formatPrepareRenameResult(result)
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`
    }
  },
})

export const lsp_rename: ToolDefinition = tool({
  description:
    "Perform a semantic rename of a symbol across the entire workspace and APPLY edits to all affected files. " +
    "Respects imports, exports, re-exports, and alias references — far safer than textual find-and-replace. " +
    "Use when: 'rename this function/class/variable project-wide safely'. " +
    "Prefer running lsp_prepare_rename first to validate the position. " +
    "Not for: renaming symbols inside installed packages / node_modules (would pollute dependencies and may miss files tsserver doesn't index), " +
    "or literal string substitution (use ast_grep_replace for structural rewrites).",
  args: {
    filePath: tool.schema.string(),
    line: tool.schema.number().min(1).describe("1-based"),
    character: tool.schema.number().min(0).describe("0-based"),
    newName: tool.schema.string().describe("New symbol name"),
  },
  execute: async (args, _context) => {
    try {
      const edit = await withLspClient(args.filePath, async (client) => {
        return (await client.rename(args.filePath, args.line, args.character, args.newName)) as WorkspaceEdit | null
      })
      const result = applyWorkspaceEdit(edit)
      const lines: string[] = []

      if (result.success) {
        lines.push(`Applied ${result.totalEdits} edit(s) to ${result.filesModified.length} file(s):`)
        for (const file of result.filesModified) {
          lines.push(`  - ${file}`)
        }
      } else {
        lines.push("Failed to apply some changes:")
        for (const err of result.errors) {
          lines.push(`  Error: ${err}`)
        }
        if (result.filesModified.length > 0) {
          lines.push(`Successfully modified: ${result.filesModified.join(", ")}`)
        }
      }

      return lines.join("\n")
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`
    }
  },
})
