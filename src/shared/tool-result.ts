import type { ToolResult } from "@opencode-ai/plugin/tool"

export interface LspToolResult<T> {
  ok: boolean
  tool: string
  summary: string
  data: T | null
  hints: string[]
  warnings: string[]
  nextActions: ToolNextAction[]
  truncated: boolean
  errors: string[]
}

export interface ToolNextAction {
  type: "read_file" | "call_tool" | "run_command"
  reason: string
  priority?: "low" | "medium" | "high"
  filePath?: string
  line?: number
  character?: number
  tool?: string
  args?: unknown
  command?: string
}

export interface ServiceResult<T> {
  ok: boolean
  data: T | null
  warnings: string[]
  errors: string[]
}

export interface RangeRef {
  start: {
    line: number
    character: number
  }
  end: {
    line: number
    character: number
  }
}

export interface LocationRef {
  filePath: string
  line: number
  character: number
  range?: RangeRef
}

export interface SnippetRef {
  startLine: number
  endLine: number
  text: string
}

export interface SymbolInput {
  filePath?: string
  line?: number
  character?: number
  packageName?: string | string[]
  symbolName?: string
  workspaceRoot?: string
}

export interface ToolResultOptions {
  hints?: string[]
  warnings?: string[]
  nextActions?: ToolNextAction[]
  truncated?: boolean
}

export function okResult<T>(
  tool: string,
  summary: string,
  data: T,
  opts: ToolResultOptions = {},
): ToolResult {
  const result: LspToolResult<T> = {
    ok: true,
    tool,
    summary,
    data,
    hints: opts.hints ?? [],
    warnings: opts.warnings ?? [],
    nextActions: opts.nextActions ?? [],
    truncated: opts.truncated ?? false,
    errors: [],
  }
  return jsonToolResult(result)
}

export function errorResult<T = never>(
  tool: string,
  message: string,
  opts: ToolResultOptions = {},
): ToolResult {
  const summary = message.startsWith("Error") ? message : `Error: ${message}`
  const result: LspToolResult<T> = {
    ok: false,
    tool,
    summary,
    data: null,
    hints: opts.hints ?? [],
    warnings: opts.warnings ?? [],
    nextActions: opts.nextActions ?? [],
    truncated: opts.truncated ?? false,
    errors: [message],
  }
  return jsonToolResult(result)
}

export function jsonToolResult<T>(result: LspToolResult<T>): ToolResult {
  return JSON.stringify(result, null, 2)
}

export function serviceOk<T>(data: T, warnings: string[] = []): ServiceResult<T> {
  return { ok: true, data, warnings, errors: [] }
}

export function serviceError<T = never>(message: string, warnings: string[] = []): ServiceResult<T> {
  return { ok: false, data: null, warnings, errors: [message] }
}
