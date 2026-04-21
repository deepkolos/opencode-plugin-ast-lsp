import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool"

import { formatPrepareRenameResult } from "./lsp-formatters"
import { withLspClient } from "./lsp-client-wrapper"
import { applyWorkspaceEdit } from "./workspace-edit"
import type { PrepareRenameDefaultBehavior, PrepareRenameResult, WorkspaceEdit } from "./types"

export const lsp_prepare_rename: ToolDefinition = tool({
  description: "Check if rename is valid. Use BEFORE lsp_rename.",
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
  description: "Rename symbol across entire workspace. APPLIES changes to all files.",
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
