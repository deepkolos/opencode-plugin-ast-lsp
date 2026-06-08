import type { Plugin, PluginInput } from "@opencode-ai/plugin"

import { createAstGrepTools } from "./ast-grep"
import {
  lsp_inspect,
  lsp_discover,
  lsp_usages,
  lsp_diagnostics,
  lsp_rename,
} from "./lsp"

import { setPluginInput } from "./shared/plugin-context"

const plugin: Plugin = async (input: PluginInput) => {
  setPluginInput(input)
  const astTools = createAstGrepTools(input)
  return {
    tool: {
      ...astTools,
      lsp_inspect,
      lsp_discover,
      lsp_usages,
      lsp_diagnostics,
      lsp_rename,
    },
  }
}

export default plugin
