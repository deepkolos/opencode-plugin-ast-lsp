import type { Plugin, PluginInput } from "@opencode-ai/plugin"

import { createAstGrepTools } from "./ast-grep"
import {
  lsp_goto_definition,
  lsp_find_references,
  lsp_symbols,
  lsp_diagnostics,
  lsp_prepare_rename,
  lsp_rename,
  lsp_hover,
} from "./lsp"

import { setPluginInput } from "./shared/plugin-context"

const plugin: Plugin = async (input: PluginInput) => {
  setPluginInput(input)
  const astTools = createAstGrepTools(input)
  return {
    tool: {
      ...astTools,
      lsp_goto_definition,
      lsp_find_references,
      lsp_symbols,
      lsp_diagnostics,
      lsp_prepare_rename,
      lsp_rename,
      lsp_hover,
    },
  }
}

export default plugin
