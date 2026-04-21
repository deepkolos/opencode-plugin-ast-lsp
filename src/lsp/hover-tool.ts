import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool"

import { formatHover } from "./lsp-formatters"
import { withLspClient } from "./lsp-client-wrapper"
import type { Hover } from "./types"

export const lsp_hover: ToolDefinition = tool({
  description: "Get hover information for a symbol. Find documentation, type definitions, and signatures.",
  args: {
    filePath: tool.schema.string(),
    line: tool.schema.number().min(1).describe("1-based"),
    character: tool.schema.number().min(0).describe("0-based"),
  },
  execute: async (args, _context) => {
    try {
      const result = await withLspClient(args.filePath, async (client) => {
        return (await client.hover(args.filePath, args.line, args.character)) as Hover | null
      })

      return formatHover(result)
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`
    }
  },
})
