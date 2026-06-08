import type { PluginInput } from "@opencode-ai/plugin"
import { tool, type ToolDefinition, type ToolResult } from "@opencode-ai/plugin/tool"
import { CLI_LANGUAGES } from "./constants"
import { runSg } from "./cli"
import {
  buildReplaceResultData,
  buildSearchResultData,
  type AstGrepReplaceInput,
  type AstGrepSearchInput,
} from "./result-formatter"
import type { CliLanguage } from "./types"
import { errorResult, okResult } from "../shared/tool-result"

async function showOutputToUser(context: unknown, output: string): Promise<void> {
  const ctx = context as {
    metadata?: (input: { metadata: { output: string } }) => void | Promise<void>
  }
  await ctx.metadata?.({ metadata: { output } })
}

function toolResultToText(result: ToolResult): string {
  return typeof result === "string" ? result : result.output
}

function getEmptyResultHint(pattern: string, lang: CliLanguage): string | null {
  const src = pattern.trim()

  if (lang === "python") {
    if (src.startsWith("class ") && src.endsWith(":")) {
      const withoutColon = src.slice(0, -1)
      return `Hint: Remove trailing colon. Try: "${withoutColon}"`
    }
    if ((src.startsWith("def ") || src.startsWith("async def ")) && src.endsWith(":")) {
      const withoutColon = src.slice(0, -1)
      return `Hint: Remove trailing colon. Try: "${withoutColon}"`
    }
  }

  if (["javascript", "typescript", "tsx"].includes(lang)) {
    if (/^(export\s+)?(async\s+)?function\s+\$[A-Z_]+\s*$/i.test(src)) {
      return `Hint: Function patterns need params and body. Try "function $NAME($$$) { $$$ }"`
    }
  }

  return null
}

function getTruncationHint(reason: string | undefined): string {
  if (reason === "max_matches") {
    return "Results were truncated by max_matches; narrow paths/globs/pattern or run another targeted search."
  }
  if (reason === "max_output_bytes") {
    return "Results were truncated by output size; narrow paths/globs/pattern before applying edits."
  }
  if (reason === "timeout") {
    return "Search timed out; narrow paths/globs/pattern or search a smaller subtree."
  }
  return "Results were truncated; narrow paths/globs/pattern for complete coverage."
}

export function createAstGrepTools(ctx: PluginInput): Record<string, ToolDefinition> {
  const ast_grep_search: ToolDefinition = tool({
    description:
      "Search code patterns across files using AST-aware matching and return structured JSON results. Supports 25 languages. " +
      "Use meta-variables: $VAR (single node), $$$ (multiple nodes). " +
      "IMPORTANT: Patterns must be complete AST nodes (valid code). " +
      "For functions, include params and body: 'export async function $NAME($$$) { $$$ }' not 'export async function $NAME'. " +
      "Examples: 'console.log($MSG)', 'def $FUNC($$$):', 'async function $NAME($$$)'. " +
      "Use this for syntax-shaped search/refactor discovery; for semantic symbol/API context, prefer lsp_discover / lsp_inspect.",
    args: {
      pattern: tool.schema.string().describe("AST pattern with meta-variables ($VAR, $$$). Must be complete AST node."),
      lang: tool.schema.enum(CLI_LANGUAGES).describe("Target language"),
      paths: tool.schema.array(tool.schema.string()).optional().describe("Paths to search (default: ['.'])"),
      globs: tool.schema.array(tool.schema.string()).optional().describe("Include/exclude globs (prefix ! to exclude)"),
      context: tool.schema.number().optional().describe("Context lines around match"),
    },
    execute: async (args, context) => {
      try {
        const input: AstGrepSearchInput = {
          pattern: args.pattern,
          lang: args.lang as CliLanguage,
          paths: args.paths ?? [ctx.directory],
          globs: args.globs,
          context: args.context,
        }
        const result = await runSg({
          pattern: input.pattern,
          lang: input.lang,
          paths: input.paths,
          globs: input.globs,
          context: input.context,
        })

        if (result.error) {
          const output = errorResult("ast_grep_search", result.error, {
            truncated: result.truncated,
          })
          const outputText = toolResultToText(output)
          await showOutputToUser(context, outputText)
          return output
        }

        const hints: string[] = []
        if (result.matches.length === 0 && !result.error) {
          const hint = getEmptyResultHint(input.pattern, input.lang)
          if (hint) {
            hints.push(hint)
          }
        }
        if (result.truncated) {
          hints.push(getTruncationHint(result.truncatedReason))
        }

        const summary = result.matches.length === 0
          ? "No matches found."
          : `Found ${result.matches.length} match(es)${result.truncated ? `; total ${result.totalMatches} before truncation.` : "."}`
        const output = okResult("ast_grep_search", summary, buildSearchResultData(result, input), {
          hints,
          truncated: result.truncated,
        })

        await showOutputToUser(context, toolResultToText(output))
        return output
      } catch (e) {
        const output = errorResult("ast_grep_search", e instanceof Error ? e.message : String(e))
        await showOutputToUser(context, toolResultToText(output))
        return output
      }
    },
  })

  const ast_grep_replace: ToolDefinition = tool({
    description:
      "Replace code patterns across files with AST-aware rewriting and return structured JSON results. " +
      "Dry-run by default; set dryRun=false only after reviewing replacements. Use meta-variables in rewrite to preserve matched content. " +
      "Example: pattern='console.log($MSG)' rewrite='logger.info($MSG)'",
    args: {
      pattern: tool.schema.string().describe("AST pattern to match"),
      rewrite: tool.schema.string().describe("Replacement pattern (can use $VAR from pattern)"),
      lang: tool.schema.enum(CLI_LANGUAGES).describe("Target language"),
      paths: tool.schema.array(tool.schema.string()).optional().describe("Paths to search"),
      globs: tool.schema.array(tool.schema.string()).optional().describe("Include/exclude globs"),
      dryRun: tool.schema.boolean().optional().describe("Preview changes without applying (default: true)"),
    },
    execute: async (args, context) => {
      try {
        const input: AstGrepReplaceInput = {
          pattern: args.pattern,
          rewrite: args.rewrite,
          lang: args.lang as CliLanguage,
          paths: args.paths ?? [ctx.directory],
          globs: args.globs,
          dryRun: args.dryRun !== false,
        }
        const result = await runSg({
          pattern: input.pattern,
          rewrite: input.rewrite,
          lang: input.lang,
          paths: input.paths,
          globs: input.globs,
          updateAll: !input.dryRun,
        })

        if (result.error) {
          const output = errorResult("ast_grep_replace", result.error, {
            truncated: result.truncated,
          })
          await showOutputToUser(context, toolResultToText(output))
          return output
        }

        const hints: string[] = []
        if (input.dryRun && result.matches.length > 0) {
          hints.push("Review data.matches, then rerun with dryRun=false to apply these replacements.")
        }
        if (result.truncated) {
          hints.push(getTruncationHint(result.truncatedReason))
        }

        const summary = result.matches.length === 0
          ? "No matches found to replace."
          : input.dryRun
          ? `${result.matches.length} replacement(s) would be made.`
          : `${result.matches.length} replacement(s) applied.`
        const output = okResult("ast_grep_replace", summary, buildReplaceResultData(result, input), {
          hints,
          truncated: result.truncated,
        })
        await showOutputToUser(context, toolResultToText(output))
        return output
      } catch (e) {
        const output = errorResult("ast_grep_replace", e instanceof Error ? e.message : String(e))
        await showOutputToUser(context, toolResultToText(output))
        return output
      }
    },
  })

  return { ast_grep_search, ast_grep_replace }
}
