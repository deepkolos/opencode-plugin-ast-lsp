import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool"

import { formatPrepareRenameResult } from "./lsp-formatters"
import { withLspClient } from "./lsp-client-wrapper"
import { okResult, errorResult } from "./tool-result"
import { applyWorkspaceEdit, summarizeWorkspaceEdit } from "./workspace-edit"
import type { PrepareRenameDefaultBehavior, PrepareRenameResult, WorkspaceEdit } from "./types"

interface PrepareRenameData {
  filePath: string
  line: number
  character: number
  canRename: boolean
  message: string
  result: PrepareRenameResult | PrepareRenameDefaultBehavior | null
}

interface RenameData {
  filePath: string
  line: number
  character: number
  newName: string
  dryRun: boolean
  prepare: PrepareRenameData
  edit?: {
    totalEdits: number
    files: string[]
    fileOperations: Array<{
      kind: "create" | "rename" | "delete"
      filePath: string
      oldFilePath?: string
    }>
    preview?: WorkspaceEdit | null
    applied: boolean
    errors: string[]
  }
}

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
      const message = formatPrepareRenameResult(result)
      return okResult<PrepareRenameData>(
        "lsp_prepare_rename",
        message,
        {
          filePath: args.filePath,
          line: args.line,
          character: args.character,
          canRename: !!result && !message.startsWith("Cannot rename"),
          message,
          result,
        },
      )
    } catch (e) {
      return errorResult("lsp_prepare_rename", e instanceof Error ? e.message : String(e))
    }
  },
})

export const lsp_rename: ToolDefinition = tool({
  description:
    "Perform a semantic rename of a symbol across the entire workspace. Internally validates with prepareRename first. " +
    "Respects imports, exports, re-exports, and alias references — far safer than textual find-and-replace. " +
    "Use when: 'rename this function/class/variable project-wide safely'. " +
    "Set dryRun=true to preview the workspace edit without writing files. " +
    "Not for: renaming symbols inside installed packages / node_modules (would pollute dependencies and may miss files tsserver doesn't index), " +
    "or literal string substitution (use ast_grep_replace for structural rewrites).",
  args: {
    filePath: tool.schema.string(),
    line: tool.schema.number().min(1).describe("1-based"),
    character: tool.schema.number().min(0).describe("0-based"),
    newName: tool.schema.string().describe("New symbol name"),
    dryRun: tool.schema.boolean().optional(),
  },
  execute: async (args, _context) => {
    try {
      const prepare = await withLspClient(args.filePath, async (client) => {
        return (await client.prepareRename(args.filePath, args.line, args.character)) as
          | PrepareRenameResult
          | PrepareRenameDefaultBehavior
          | null
      })
      const prepareText = formatPrepareRenameResult(prepare)
      const prepareData: PrepareRenameData = {
        filePath: args.filePath,
        line: args.line,
        character: args.character,
        canRename: !!prepare && !prepareText.startsWith("Cannot rename"),
        message: prepareText,
        result: prepare,
      }
      if (!prepare || prepareText.startsWith("Cannot rename")) {
        return okResult<RenameData>(
          "lsp_rename",
          prepareText,
          {
            filePath: args.filePath,
            line: args.line,
            character: args.character,
            newName: args.newName,
            dryRun: args.dryRun ?? false,
            prepare: prepareData,
          },
        )
      }

      const edit = await withLspClient(args.filePath, async (client) => {
        return (await client.rename(args.filePath, args.line, args.character, args.newName)) as WorkspaceEdit | null
      })
      const editSummary = summarizeWorkspaceEdit(edit)
      if (args.dryRun) {
        return okResult<RenameData>(
          "lsp_rename",
          `Dry run rename preview: ${editSummary.totalEdits} edit(s) across ${editSummary.files.length} file(s).`,
          {
            filePath: args.filePath,
            line: args.line,
            character: args.character,
            newName: args.newName,
            dryRun: true,
            prepare: prepareData,
            edit: {
              totalEdits: editSummary.totalEdits,
              files: editSummary.files,
              fileOperations: editSummary.fileOperations,
              preview: edit,
              applied: false,
              errors: [],
            },
          },
        )
      }
      const result = applyWorkspaceEdit(edit)
      return okResult<RenameData>(
        "lsp_rename",
        result.success
          ? `Applied ${result.totalEdits} edit(s) to ${result.filesModified.length} file(s).`
          : "Failed to apply some rename changes.",
        {
          filePath: args.filePath,
          line: args.line,
          character: args.character,
          newName: args.newName,
          dryRun: false,
          prepare: prepareData,
            edit: {
              totalEdits: result.totalEdits,
              files: result.filesModified,
              fileOperations: editSummary.fileOperations,
              applied: result.success,
              errors: result.errors,
            },
        },
        { warnings: result.errors },
      )
    } catch (e) {
      return errorResult("lsp_rename", e instanceof Error ? e.message : String(e))
    }
  },
})
