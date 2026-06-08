import { existsSync, readFileSync } from "fs"

import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool"

import { withLspClient } from "./lsp-client-wrapper"
import {
  resolvePackageSymbolLocations,
  toWorkspaceRoot,
} from "./package-resolution"
import { ensureLspServersInstalled } from "./server-auto-installer"
import { errorResult, okResult, uriToFilePath, type LocationRef, type SnippetRef } from "./tool-result"
import type { Location } from "./types"

interface UsageInfo {
  location: LocationRef
  snippet?: SnippetRef
}

interface UsageGroup {
  filePath: string
  usages: UsageInfo[]
}

interface UsagesData {
  input: {
    filePath?: string
    line?: number
    character?: number
    packageName?: string | string[]
    symbolName?: string
  }
  groups: UsageGroup[]
  total: number
  shown: number
}

function locationToUsage(loc: Location, contextLines: number): UsageInfo {
  const filePath = uriToFilePath(loc.uri)
  const line = loc.range.start.line + 1
  const character = loc.range.start.character
  return {
    location: {
      filePath,
      line,
      character,
      range: loc.range,
    },
    snippet: readSnippet(filePath, line, contextLines),
  }
}

function readSnippet(filePath: string, line: number, contextLines: number): SnippetRef | undefined {
  if (!existsSync(filePath)) return undefined
  let text = ""
  try {
    text = readFileSync(filePath, "utf-8")
  } catch {
    return undefined
  }
  const lines = text.split("\n")
  const start = Math.max(1, line - contextLines)
  const end = Math.min(lines.length, line + contextLines)
  const output: string[] = []
  for (let i = start; i <= end; i++) {
    const marker = i === line ? ">" : " "
    output.push(`${marker} ${i}: ${lines[i - 1] ?? ""}`)
  }
  return { startLine: start, endLine: end, text: output.join("\n") }
}

function groupUsages(refs: UsageInfo[]): UsageGroup[] {
  const groups = new Map<string, UsageInfo[]>()
  for (const ref of refs) {
    const group = groups.get(ref.location.filePath) ?? []
    group.push(ref)
    groups.set(ref.location.filePath, group)
  }

  return Array.from(groups, ([filePath, usages]) => ({ filePath, usages }))
}

export const lsp_usages: ToolDefinition = tool({
  description:
    "Find real usages and impact of a symbol, with source snippets. Use this when changing code, learning project call patterns, " +
    "or checking where a package API is referenced. Supports source positions and packageName + symbolName.",
  args: {
    filePath: tool.schema.string().optional(),
    line: tool.schema.number().min(1).optional().describe("1-based"),
    character: tool.schema.number().min(0).optional().describe("0-based"),
    packageName: tool.schema
      .union([tool.schema.string(), tool.schema.array(tool.schema.string())])
      .optional()
      .describe("Package name (exact), array, glob, or regex literal '/.../'"),
    symbolName: tool.schema
      .string()
      .optional()
      .describe("Required together with packageName"),
    workspaceRoot: tool.schema.string().optional(),
    includeDeclaration: tool.schema.boolean().optional(),
    contextLines: tool.schema.number().min(0).max(20).optional(),
    limit: tool.schema.number().min(1).max(1000).optional(),
    maxPackages: tool.schema.number().min(1).max(500).optional(),
  },
  execute: async (args, _context) => {
    try {
      const includeDeclaration = args.includeDeclaration ?? true
      const contextLines = args.contextLines ?? 3
      const limit = args.limit ?? 100

      if (args.packageName) {
        if (!args.symbolName) {
          return errorResult("lsp_usages", "symbolName is required when packageName is provided")
        }
        await ensureLspServersInstalled()
        const workspaceRoot = toWorkspaceRoot(args.workspaceRoot)
        const locations = resolvePackageSymbolLocations(
          args.packageName,
          args.symbolName,
          workspaceRoot,
          args.maxPackages ?? 20,
        )
        if (locations.length === 0) {
          const names = Array.isArray(args.packageName)
            ? args.packageName.join(", ")
            : args.packageName
          return errorResult("lsp_usages", `Symbol "${args.symbolName}" not found in package(s) matching: ${names}`)
        }

        const allUsages: UsageInfo[] = []
        const warnings: string[] = []
        let total = 0
        for (const loc of locations) {
          const result = await withLspClient(loc.filePath, async (client) => {
            return (await client.references(
              loc.filePath,
              loc.line,
              loc.character,
              includeDeclaration,
            )) as Location[] | null
          }).catch((e) => {
            warnings.push(`[${loc.pkg}] ${e instanceof Error ? e.message : String(e)}`)
            return null
          })
          if (!result) continue
          total += result.length
          allUsages.push(...result.slice(0, Math.max(0, limit - allUsages.length)).map((ref) => locationToUsage(ref, contextLines)))
        }
        return okResult<UsagesData>(
          "lsp_usages",
          `Found ${total} usage(s), showing ${allUsages.length}.`,
          {
            input: {
              packageName: args.packageName,
              symbolName: args.symbolName,
            },
            groups: groupUsages(allUsages),
            total,
            shown: allUsages.length,
          },
          {
            warnings,
            truncated: allUsages.length < total,
            hints: allUsages.length < total ? ["Results were truncated; narrow the symbol or increase limit."] : [],
          },
        )
      }

      if (!args.filePath || args.line === undefined || args.character === undefined) {
        return errorResult("lsp_usages", "provide either packageName + symbolName, or filePath + line + character")
      }

      const result = await withLspClient(args.filePath, async (client) => {
        return (await client.references(
          args.filePath!,
          args.line!,
          args.character!,
          includeDeclaration,
        )) as Location[] | null
      })
      if (!result || result.length === 0) {
        return okResult<UsagesData>("lsp_usages", "No usages found.", {
          input: {
            filePath: args.filePath,
            line: args.line,
            character: args.character,
          },
          groups: [],
          total: 0,
          shown: 0,
        })
      }

      const limited = result.slice(0, limit).map((ref) => locationToUsage(ref, contextLines))
      return okResult<UsagesData>(
        "lsp_usages",
        `Found ${result.length} usage(s), showing ${limited.length}.`,
        {
          input: {
            filePath: args.filePath,
            line: args.line,
            character: args.character,
          },
          groups: groupUsages(limited),
          total: result.length,
          shown: limited.length,
        },
        {
          truncated: limited.length < result.length,
          hints: limited.length < result.length ? ["Results were truncated; narrow the symbol or increase limit."] : [],
        },
      )
    } catch (e) {
      return errorResult("lsp_usages", e instanceof Error ? e.message : String(e))
    }
  },
})
