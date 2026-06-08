import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool"

import { DEFAULT_MAX_SYMBOLS } from "./constants"
import { formatSymbolKind } from "./lsp-formatters"
import { withLspClient } from "./lsp-client-wrapper"
import { errorResult, locationToRef, okResult, type LocationRef } from "./tool-result"
import type { DocumentSymbol, SymbolInfo } from "./types"

interface SymbolSummary {
  name: string
  kind: string
  displayName: string
  location?: LocationRef
  children?: SymbolSummary[]
  containerName?: string
}

interface SymbolsData {
  input: {
    filePath: string
    scope: "document" | "workspace"
    query?: string
  }
  symbols: SymbolSummary[]
  total: number
  shown: number
}

function documentSymbolToSummary(symbol: DocumentSymbol): SymbolSummary {
  return {
    name: symbol.name,
    kind: formatSymbolKind(symbol.kind),
    displayName: `${symbol.name} (${formatSymbolKind(symbol.kind)})`,
    location: {
      filePath: "",
      line: symbol.range.start.line + 1,
      character: symbol.range.start.character,
      range: symbol.range,
    },
    children: symbol.children?.map(documentSymbolToSummary),
  }
}

function symbolInfoToSummary(symbol: SymbolInfo): SymbolSummary {
  return {
    name: symbol.name,
    kind: formatSymbolKind(symbol.kind),
    displayName: `${symbol.name} (${formatSymbolKind(symbol.kind)})`,
    location: locationToRef(symbol.location),
    containerName: symbol.containerName,
  }
}

export const lsp_symbols: ToolDefinition = tool({
  description:
    "List symbols either as a FILE outline (classes/functions/methods hierarchy) or as a WORKSPACE fuzzy search by name. " +
    "Use scope='document' when: 'outline this file', 'what are the public methods of this class?'. " +
    "Use scope='workspace' when: 'find a class called UserService somewhere in the project'. " +
    "Not for: enumerating exports of an npm package (use lsp_package_exports), " +
    "locating a symbol inside node_modules by package (use lsp_package_symbol), " +
    "or structural code search by pattern (use ast_grep_search).",
  args: {
    filePath: tool.schema.string().describe("File path for LSP context"),
    scope: tool.schema
      .enum(["document", "workspace"])
      .default("document")
      .describe("'document' for file symbols, 'workspace' for project-wide search"),
    query: tool.schema.string().optional().describe("Symbol name to search (required for workspace scope)"),
    limit: tool.schema.number().optional().describe("Max results (default 50)"),
  },
  execute: async (args, _context) => {
    try {
      const scope = args.scope ?? "document"

      if (scope === "workspace") {
        if (!args.query) {
          return errorResult("lsp_symbols", "'query' is required for workspace scope")
        }

        const result = await withLspClient(args.filePath, async (client) => {
          return (await client.workspaceSymbols(args.query!)) as SymbolInfo[] | null
        })

        if (!result || result.length === 0) {
          return okResult<SymbolsData>("lsp_symbols", "No symbols found.", {
            input: { filePath: args.filePath, scope, query: args.query },
            symbols: [],
            total: 0,
            shown: 0,
          })
        }

        const total = result.length
        const limit = Math.min(args.limit ?? DEFAULT_MAX_SYMBOLS, DEFAULT_MAX_SYMBOLS)
        const truncated = total > limit
        const limited = result.slice(0, limit)
        return okResult<SymbolsData>(
          "lsp_symbols",
          `Found ${total} workspace symbol(s), showing ${limited.length}.`,
          {
            input: { filePath: args.filePath, scope, query: args.query },
            symbols: limited.map(symbolInfoToSummary),
            total,
            shown: limited.length,
          },
          { truncated },
        )
      } else {
        const result = await withLspClient(args.filePath, async (client) => {
          return (await client.documentSymbols(args.filePath)) as DocumentSymbol[] | SymbolInfo[] | null
        })

        if (!result || result.length === 0) {
          return okResult<SymbolsData>("lsp_symbols", "No symbols found.", {
            input: { filePath: args.filePath, scope },
            symbols: [],
            total: 0,
            shown: 0,
          })
        }

        const total = result.length
        const limit = Math.min(args.limit ?? DEFAULT_MAX_SYMBOLS, DEFAULT_MAX_SYMBOLS)
        const truncated = total > limit
        const limited = truncated ? result.slice(0, limit) : result

        const symbols = "range" in limited[0]
          ? (limited as DocumentSymbol[]).map(documentSymbolToSummary)
          : (limited as SymbolInfo[]).map(symbolInfoToSummary)
        for (const symbol of symbols) {
          if (symbol.location && !symbol.location.filePath) symbol.location.filePath = args.filePath
        }
        return okResult<SymbolsData>(
          "lsp_symbols",
          `Found ${total} document symbol(s), showing ${limited.length}.`,
          {
            input: { filePath: args.filePath, scope },
            symbols,
            total,
            shown: limited.length,
          },
          { truncated },
        )
      }
    } catch (e) {
      return errorResult("lsp_symbols", e instanceof Error ? e.message : String(e))
    }
  },
})
