#!/usr/bin/env bun

import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import type { PluginInput } from "@opencode-ai/plugin"
import type { ToolContext, ToolDefinition, ToolResult } from "@opencode-ai/plugin/tool"

import { lspManager } from "./lsp/lsp-server"
import { createPublicToolRegistry } from "./tool-registry"

interface CliOptions {
  cwd: string
  input?: string
  inputFile?: string
  stdin: boolean
  pretty: boolean
}

interface CliEnvelope<T = unknown> {
  ok: boolean
  tool: string
  summary: string
  data: T | null
  hints: string[]
  warnings: string[]
  nextActions: unknown[]
  truncated: boolean
  errors: string[]
}

function usage(): string {
  return [
    "Usage:",
    "  ast-lsp list-tools [--cwd <dir>] [--json]",
    "  ast-lsp schema <tool> [--cwd <dir>]",
    "  ast-lsp run <tool> [--cwd <dir>] (--input <json> | --input-file <path> | --stdin) [--pretty]",
    "",
    "Examples:",
    "  ast-lsp run lsp_inspect --input '{\"filePath\":\"src/index.ts\",\"line\":1,\"character\":0}'",
    "  echo '{\"packageName\":\"@scope/pkg\",\"symbolName\":\"Texture2D\"}' | ast-lsp run lsp_inspect --stdin",
  ].join("\n")
}

function makeEnvelope(
  tool: string,
  summary: string,
  opts: Partial<Omit<CliEnvelope, "tool" | "summary">> = {},
): CliEnvelope {
  return {
    ok: opts.ok ?? false,
    tool,
    summary,
    data: opts.data ?? null,
    hints: opts.hints ?? [],
    warnings: opts.warnings ?? [],
    nextActions: opts.nextActions ?? [],
    truncated: opts.truncated ?? false,
    errors: opts.errors ?? [],
  }
}

function parseCommonOptions(argv: string[]): { positional: string[]; options: CliOptions } {
  const positional: string[] = []
  const options: CliOptions = {
    cwd: process.cwd(),
    stdin: false,
    pretty: false,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--cwd") {
      const value = argv[++i]
      if (!value) throw new Error("--cwd requires a directory")
      options.cwd = value
    } else if (arg === "--input") {
      const value = argv[++i]
      if (!value) throw new Error("--input requires a JSON string")
      options.input = value
    } else if (arg === "--input-file") {
      const value = argv[++i]
      if (!value) throw new Error("--input-file requires a path")
      options.inputFile = value
    } else if (arg === "--stdin") {
      options.stdin = true
    } else if (arg === "--pretty" || arg === "--json") {
      options.pretty = true
    } else if (arg === "--help" || arg === "-h") {
      positional.push("help")
    } else {
      positional.push(arg)
    }
  }

  return { positional, options }
}

function toolResultToText(result: ToolResult): string {
  return typeof result === "string" ? result : result.output
}

function writeJson(value: unknown, pretty: boolean): void {
  process.stdout.write(`${JSON.stringify(value, null, pretty ? 2 : 0)}\n`)
}

function writeToolResult(result: ToolResult, pretty: boolean): void {
  const text = toolResultToText(result)
  try {
    writeJson(JSON.parse(text), pretty)
  } catch {
    process.stdout.write(text.endsWith("\n") ? text : `${text}\n`)
  }
}

function summarizeArgs(tool: ToolDefinition): Record<string, { description?: string }> {
  return Object.fromEntries(
    Object.entries(tool.args).map(([name, schema]) => {
      const schemaInfo = schema as unknown as { description?: unknown }
      const description = typeof schemaInfo.description === "string"
        ? schemaInfo.description
        : undefined
      return [name, { description }]
    }),
  )
}

async function readInputJson(options: CliOptions): Promise<unknown> {
  const sources = [options.input !== undefined, options.inputFile !== undefined, options.stdin].filter(Boolean).length
  if (sources !== 1) {
    throw new Error("provide exactly one of --input, --input-file, or --stdin")
  }

  const raw = options.inputFile
    ? readFileSync(resolve(options.cwd, options.inputFile), "utf-8")
    : options.stdin
    ? await new Response(Bun.stdin.stream()).text()
    : options.input ?? ""

  try {
    return JSON.parse(raw)
  } catch (e) {
    throw new Error(`invalid JSON input: ${e instanceof Error ? e.message : String(e)}`)
  }
}

function makeToolContext(cwd: string): ToolContext {
  const controller = new AbortController()
  return {
    sessionID: "cli",
    messageID: "cli",
    agent: "cli",
    directory: cwd,
    worktree: cwd,
    abort: controller.signal,
    metadata() {},
    ask() {
      throw new Error("Interactive permission prompts are not supported by the ast-lsp CLI.")
    },
  } as ToolContext
}

async function run(argv: string[]): Promise<number> {
  let parsed: { positional: string[]; options: CliOptions }
  try {
    parsed = parseCommonOptions(argv)
  } catch (e) {
    writeJson(makeEnvelope("cli", e instanceof Error ? e.message : String(e), {
      errors: [e instanceof Error ? e.message : String(e)],
    }), false)
    return 2
  }

  const { positional, options } = parsed
  const command = positional[0]
  if (!command || command === "help") {
    process.stdout.write(`${usage()}\n`)
    return command ? 0 : 2
  }

  const cwd = resolve(options.cwd)
  process.chdir(cwd)
  const input = { directory: cwd } as PluginInput
  const registry = createPublicToolRegistry(input)

  if (command === "list-tools") {
    writeJson({
      ok: true,
      tools: Object.entries(registry).map(([name, tool]) => ({
        name,
        description: tool.description,
        args: Object.keys(tool.args),
      })),
    }, options.pretty)
    return 0
  }

  const toolName = positional[1]
  if (!toolName) {
    writeJson(makeEnvelope("cli", `${command} requires a tool name`, {
      errors: [`${command} requires a tool name`],
    }), options.pretty)
    return 2
  }

  const tool = registry[toolName as keyof typeof registry]
  if (!tool) {
    writeJson(makeEnvelope(toolName, `Unknown tool: ${toolName}`, {
      errors: [`Unknown tool: ${toolName}`],
      hints: [`Run "ast-lsp list-tools --json" to see available tools.`],
    }), options.pretty)
    return 1
  }

  if (command === "schema") {
    writeJson({
      ok: true,
      tool: toolName,
      description: tool.description,
      args: summarizeArgs(tool),
    }, options.pretty)
    return 0
  }

  if (command !== "run") {
    writeJson(makeEnvelope("cli", `Unknown command: ${command}`, {
      errors: [`Unknown command: ${command}`],
      hints: [usage()],
    }), options.pretty)
    return 2
  }

  let args: unknown
  try {
    args = await readInputJson(options)
  } catch (e) {
    writeJson(makeEnvelope(toolName, e instanceof Error ? e.message : String(e), {
      errors: [e instanceof Error ? e.message : String(e)],
    }), options.pretty)
    return 2
  }

  const result = await tool.execute(args as never, makeToolContext(cwd))
  writeToolResult(result, options.pretty)
  const parsedResult = (() => {
    try {
      return JSON.parse(toolResultToText(result)) as { ok?: unknown }
    } catch {
      return null
    }
  })()
  return parsedResult?.ok === false ? 1 : 0
}

try {
  const code = await run(process.argv.slice(2))
  await lspManager.stopAll()
  process.exit(code)
} catch (e) {
  writeJson(makeEnvelope("cli", e instanceof Error ? e.message : String(e), {
    errors: [e instanceof Error ? e.message : String(e)],
  }), false)
  try {
    await lspManager.stopAll()
  } catch {}
  process.exit(1)
}
