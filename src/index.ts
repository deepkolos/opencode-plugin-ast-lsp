import type { Plugin, PluginInput } from "@opencode-ai/plugin"

import { createPublicToolRegistry } from "./tool-registry"

const plugin: Plugin = async (input: PluginInput) => {
  return {
    tool: createPublicToolRegistry(input),
  }
}

export default plugin
