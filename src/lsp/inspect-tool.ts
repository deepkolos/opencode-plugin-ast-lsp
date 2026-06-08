import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool"

import { lsp_hover } from "./hover-tool"
import { withLspClient } from "./lsp-client-wrapper"
import {
  resolvePackageSymbolLocations,
  toWorkspaceRoot,
  toNodeModulesRelativePath,
} from "./package-resolution"
import { ensureLspServersInstalled } from "./server-auto-installer"
import { collectTypeContextInfo, type TypeContextInfo, type TypeContextMode } from "./services/type-context"
import { errorResult, firstLocation, locationToRef, okResult, type LocationRef, type ToolNextAction } from "./tool-result"

interface InspectSymbol {
  packageName?: string
  symbolName?: string
  source?: LocationRef
  displaySource?: string
  definition?: LocationRef
  displayDefinition?: string
  hoverText?: string
  members?: unknown
  memberStats?: unknown
  memberHints?: string[]
  typeContext: TypeContextInfo
  nextActions?: ToolNextAction[]
}

interface InspectData {
  input: {
    filePath?: string
    line?: number
    character?: number
    packageName?: string | string[]
    symbolName?: string
    mode: TypeContextMode
  }
  symbols: InspectSymbol[]
}

function parseToolJson(output: unknown): unknown {
  if (output && typeof output === "object" && "output" in output) {
    return parseToolJson((output as { output: string }).output)
  }
  if (typeof output !== "string") return output
  try {
    return JSON.parse(output)
  } catch {
    return output
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null
  return value as Record<string, unknown>
}

function getHoverBlocks(envelope: unknown): Record<string, unknown>[] {
  const data = asRecord(asRecord(envelope)?.data)
  const blocks = data?.blocks
  return Array.isArray(blocks) ? blocks.filter((item): item is Record<string, unknown> => !!asRecord(item)) : []
}

function getStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function getNextActions(envelope: unknown): ToolNextAction[] {
  const actions = asRecord(envelope)?.nextActions
  return Array.isArray(actions) ? actions.filter((item): item is ToolNextAction => !!asRecord(item)) : []
}

function uniqueNextActions(actions: ToolNextAction[]): ToolNextAction[] {
  const seen = new Set<string>()
  const output: ToolNextAction[] = []
  for (const action of actions) {
    const key = `${action.type}:${action.filePath ?? ""}:${action.line ?? ""}:${action.character ?? ""}:${action.tool ?? ""}:${action.reason}`
    if (seen.has(key)) continue
    seen.add(key)
    output.push(action)
  }
  return output
}

function typeContextNextActions(typeContext: TypeContextInfo): ToolNextAction[] {
  const actions: ToolNextAction[] = []
  const seen = new Set<string>()
  for (const item of typeContext.unresolvedTypes) {
    if (!item.location?.filePath) continue
    const key = `${item.location.filePath}:${item.location.line}:${item.location.character}`
    if (seen.has(key)) continue
    seen.add(key)
    actions.push({
      type: "read_file",
      priority: item.reason === "maxDepth" || item.reason === "maxTypes" || item.reason === "maxBytes" ? "high" : "medium",
      reason: `Related type "${item.name}" was not expanded because of ${item.reason}; read its declaration for complete context.`,
      filePath: item.location.filePath,
      line: item.location.line,
      character: item.location.character,
    })
  }
  return actions
}

function inspectSymbolFromHoverBlock(block: Record<string, unknown> | undefined) {
  return {
    hoverText: typeof block?.hoverText === "string" ? block.hoverText : undefined,
    members: block?.members,
    memberStats: block?.memberStats,
    memberHints: getStringArray(block?.memberHints),
  }
}

export const lsp_inspect: ToolDefinition = tool({
  description:
    "Understand how to use a symbol or package API. Use this first when you need docs, definition, members, signatures, " +
    "and related parameter/return/interface types. Supports source positions and packageName + symbolName. " +
    "mode='surface' gives direct usage context; mode='deep' recursively expands related types within budget. " +
    "Prefer this over raw hover/definition/package-symbol style lookups.",
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
    mode: tool.schema.enum(["surface", "deep"]).optional(),
    maxDepth: tool.schema.number().min(1).max(10).optional(),
    maxMembers: tool.schema.number().min(1).max(500).optional(),
    maxTypes: tool.schema.number().min(1).max(500).optional(),
    maxBytes: tool.schema.number().min(1000).max(500000).optional(),
    maxPackages: tool.schema.number().min(1).max(500).optional(),
  },
  execute: async (args, context) => {
    try {
      const mode: TypeContextMode = (args.mode as TypeContextMode | undefined) ?? "surface"
      const maxDepth = args.maxDepth ?? (mode === "deep" ? 3 : 1)
      const maxMembers = args.maxMembers ?? 50
      const maxTypes = args.maxTypes ?? 30
      const maxBytes = args.maxBytes ?? 60000

      if (args.packageName) {
        if (!args.symbolName) {
          return errorResult("lsp_inspect", "symbolName is required when packageName is provided")
        }

        await ensureLspServersInstalled()
        const workspaceRoot = toWorkspaceRoot(args.workspaceRoot)
        const maxPackages = args.maxPackages ?? 20
        const locations = resolvePackageSymbolLocations(
          args.packageName,
          args.symbolName,
          workspaceRoot,
          maxPackages,
        )

        if (locations.length === 0) {
          const names = Array.isArray(args.packageName)
            ? args.packageName.join(", ")
            : args.packageName
          return errorResult("lsp_inspect", `Symbol "${args.symbolName}" not found in package(s) matching: ${names}`)
        }

        const hoverEnvelope = parseToolJson(await lsp_hover.execute(
          {
            packageName: args.packageName,
            symbolName: args.symbolName,
            workspaceRoot,
            maxPackages,
            includeMembers: true,
            maxMembers,
          },
          context,
        ))
        const hoverBlocks = getHoverBlocks(hoverEnvelope)
        const nextActions = [...getNextActions(hoverEnvelope)]
        const warnings = getStringArray(asRecord(hoverEnvelope)?.warnings)

        const symbols: InspectSymbol[] = []
        for (const [index, loc] of locations.entries()) {
          const displayPath = loc.nodeModulesRoot
            ? toNodeModulesRelativePath(loc.filePath, loc.nodeModulesRoot)
            : loc.filePath
          const hoverBlock = hoverBlocks[index]
          const typeContext = collectTypeContextInfo({
            filePath: loc.filePath,
            line: loc.line,
            character: loc.character,
            mode,
            maxDepth,
            maxTypes,
            maxBytes,
          })
          const symbolNextActions = uniqueNextActions([
            ...typeContextNextActions(typeContext),
            ...getNextActions(hoverEnvelope).filter((action) => action.filePath === loc.filePath),
          ])
          nextActions.push(...symbolNextActions)
          symbols.push({
            packageName: loc.pkg,
            symbolName: args.symbolName,
            source: { filePath: loc.filePath, line: loc.line, character: loc.character },
            displaySource: `${displayPath}:${loc.line}:${loc.character}`,
            definition: { filePath: loc.filePath, line: loc.line, character: loc.character },
            displayDefinition: `${displayPath}:${loc.line}:${loc.character}`,
            ...inspectSymbolFromHoverBlock(hoverBlock),
            typeContext,
            nextActions: symbolNextActions,
          })
        }

        const truncated = symbols.some((s) => s.typeContext.truncated)
        return okResult<InspectData>(
          "lsp_inspect",
          `Inspected ${symbols.length} package symbol match(es) for "${args.symbolName}".`,
          {
            input: {
              packageName: args.packageName,
              symbolName: args.symbolName,
              mode,
            },
            symbols,
          },
          {
            truncated,
            hints: truncated ? ["Some related types were not expanded; increase maxDepth/maxTypes/maxBytes for more context."] : [],
            warnings,
            nextActions: uniqueNextActions(nextActions),
          },
        )
      }

      if (!args.filePath || args.line === undefined || args.character === undefined) {
        return errorResult("lsp_inspect", "provide either packageName + symbolName, or filePath + line + character")
      }

      const hoverEnvelope = parseToolJson(await lsp_hover.execute(
        {
          filePath: args.filePath,
          line: args.line,
          character: args.character,
          includeMembers: true,
          maxMembers,
        },
        context,
      ))
      const hoverBlock = getHoverBlocks(hoverEnvelope)[0]

      const definition = await withLspClient(args.filePath, async (client) => {
        const loc = firstLocation(await client.definition(args.filePath!, args.line!, args.character!))
        return loc ? locationToRef(loc) : null
      }).catch(() => null)

      const target = definition
        ? { filePath: definition.filePath, line: definition.line, character: definition.character }
        : { filePath: args.filePath, line: args.line, character: args.character }
      const typeContext = collectTypeContextInfo({
        filePath: target.filePath,
        line: target.line,
        character: target.character,
        mode,
        maxDepth,
        maxTypes,
        maxBytes,
      })
      const nextActions = uniqueNextActions([
        ...getNextActions(hoverEnvelope),
        ...typeContextNextActions(typeContext),
      ])

      return okResult<InspectData>(
        "lsp_inspect",
        `Inspected symbol at ${args.filePath}:${args.line}:${args.character}.`,
        {
          input: {
            filePath: args.filePath,
            line: args.line,
            character: args.character,
            mode,
          },
          symbols: [{
            source: { filePath: args.filePath, line: args.line, character: args.character },
            definition: definition ?? undefined,
            displayDefinition: definition ? `${definition.filePath}:${definition.line}:${definition.character}` : undefined,
            ...inspectSymbolFromHoverBlock(hoverBlock),
            typeContext,
            nextActions,
          }],
        },
        {
          truncated: typeContext.truncated,
          hints: typeContext.truncated ? ["Some related types were not expanded; increase maxDepth/maxTypes/maxBytes for more context."] : [],
          warnings: getStringArray(asRecord(hoverEnvelope)?.warnings),
          nextActions,
        },
      )
    } catch (e) {
      return errorResult("lsp_inspect", e instanceof Error ? e.message : String(e))
    }
  },
})
