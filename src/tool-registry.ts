import type { PluginInput } from "@opencode-ai/plugin"
import type { ToolDefinition } from "@opencode-ai/plugin/tool"

import { createAstGrepTools } from "./ast-grep"
import {
  lsp_diagnostics,
  lsp_discover,
  lsp_inspect,
  lsp_rename,
  lsp_usages,
} from "./lsp"
import { setPluginInput } from "./shared/plugin-context"

export type PublicToolName =
  | "ast_grep_search"
  | "ast_grep_replace"
  | "lsp_inspect"
  | "lsp_discover"
  | "lsp_usages"
  | "lsp_diagnostics"
  | "lsp_rename"

export type PublicToolRegistry = Record<PublicToolName, ToolDefinition>

export function createPublicToolRegistry(input: PluginInput): PublicToolRegistry {
  setPluginInput(input)
  const astTools = createAstGrepTools(input)
  return {
    ast_grep_search: astTools.ast_grep_search,
    ast_grep_replace: astTools.ast_grep_replace,
    lsp_inspect,
    lsp_discover,
    lsp_usages,
    lsp_diagnostics,
    lsp_rename,
  }
}
