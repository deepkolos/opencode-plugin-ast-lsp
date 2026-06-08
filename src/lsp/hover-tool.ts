import { readFileSync } from "fs"
import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool"

import { formatHover, formatLocation } from "./lsp-formatters"
import type { LSPClient } from "./lsp-client"
import { withLspClient } from "./lsp-client-wrapper"
import {
  resolvePackageSymbolLocations,
  toWorkspaceRoot,
  toNodeModulesRelativePath,
  withProbeFile,
} from "./package-resolution"
import type { UnifiedSymbolKind } from "./package-resolution"
import { ensureLspServersInstalled } from "./server-auto-installer"
import { errorResult, locationToRef, okResult, type ToolNextAction } from "./tool-result"
import type { Hover, Location, LocationLink, Position } from "./types"

const DEFAULT_MAX_MEMBERS = 50
const METHOD_COMPLETION_KINDS = new Set([2, 3, 4])
const PROPERTY_COMPLETION_KINDS = new Set([5, 10, 21, 22])
const PRIMITIVE_TYPE_NAMES = new Set([
  "any",
  "bigint",
  "boolean",
  "never",
  "null",
  "number",
  "object",
  "string",
  "symbol",
  "undefined",
  "unknown",
  "void",
])

type MemberKind = "Method" | "Property"

interface CompletionItemLike {
  label?: unknown
  kind?: unknown
  detail?: unknown
  documentation?: unknown
  tags?: unknown
  deprecated?: unknown
}

interface CompletionResult {
  items: CompletionItemLike[]
  isIncomplete: boolean
}

interface HoverMember {
  name: string
  kind: MemberKind
  detail?: string
  documentation?: string
  deprecated: boolean
}

interface HoverMemberDetails {
  members: HoverMember[]
  totalMembers: number
  isIncomplete: boolean
  truncated: boolean
  resolveFailures: number
  missingDetails: number
  hints: string[]
}

interface HoverMemberGroups {
  methods: HoverMember[]
  properties: HoverMember[]
}

interface HoverMemberStats {
  totalMembers: number
  shownMembers: number
  methodCount: number
  propertyCount: number
  isIncomplete: boolean
  truncated: boolean
  resolveFailures: number
  missingDetails: number
}

interface HoverBlockData {
  packageName?: string
  source?: string
  displaySource?: string
  definition?: string
  displayDefinition?: string
  hoverText: string
  members?: HoverMemberGroups
  memberStats?: HoverMemberStats
  memberHints?: string[]
  text: string
}

interface HoverData {
  input: {
    filePath?: string
    line?: number
    character?: number
    packageName?: string | string[]
    symbolName?: string
    includeMembers: boolean
    maxMembers: number
  }
  blocks: HoverBlockData[]
}

function firstDefinitionLocation(
  definition: unknown,
): Location | LocationLink | null {
  if (!definition) return null
  if (Array.isArray(definition)) {
    return (definition[0] as Location | LocationLink | undefined) ?? null
  }
  return definition as Location | LocationLink
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null
  return value as Record<string, unknown>
}

function isCompletionItemLike(value: unknown): value is CompletionItemLike {
  const record = asRecord(value)
  return !!record && typeof record.label === "string"
}

function normalizeCompletionResult(value: unknown): CompletionResult {
  if (Array.isArray(value)) {
    return {
      items: value.filter(isCompletionItemLike),
      isIncomplete: false,
    }
  }

  const record = asRecord(value)
  if (!record) return { items: [], isIncomplete: false }
  const rawItems = Array.isArray(record.items) ? record.items : []
  return {
    items: rawItems.filter(isCompletionItemLike),
    isIncomplete: record.isIncomplete === true,
  }
}

function completionItemLabel(item: CompletionItemLike): string {
  return typeof item.label === "string" ? item.label : ""
}

function completionItemKind(item: CompletionItemLike): number | undefined {
  return typeof item.kind === "number" ? item.kind : undefined
}

function completionItemDetail(item: CompletionItemLike): string | undefined {
  return typeof item.detail === "string" && item.detail.trim()
    ? item.detail.trim()
    : undefined
}

function documentationToText(value: unknown): string | undefined {
  if (typeof value === "string") {
    const text = value.trim()
    return text || undefined
  }

  const record = asRecord(value)
  if (record && typeof record.value === "string") {
    const text = record.value.trim()
    return text || undefined
  }

  return undefined
}

function isDeprecatedCompletionItem(item: CompletionItemLike): boolean {
  if (item.deprecated === true) return true
  if (Array.isArray(item.tags)) return item.tags.includes(1)
  return false
}

function classifyCompletionItem(item: CompletionItemLike): MemberKind | null {
  const kind = completionItemKind(item)
  if (kind !== undefined) {
    if (METHOD_COMPLETION_KINDS.has(kind)) return "Method"
    if (PROPERTY_COMPLETION_KINDS.has(kind)) return "Property"
  }

  const detail = completionItemDetail(item)?.toLowerCase() ?? ""
  if (detail.startsWith("(method)") || detail.startsWith("(function)") || detail.startsWith("(constructor)")) {
    return "Method"
  }
  if (
    detail.startsWith("(property)") ||
    detail.startsWith("(field)") ||
    detail.startsWith("(getter)") ||
    detail.startsWith("(setter)") ||
    detail.startsWith("(enum member)") ||
    detail.startsWith("(const)")
  ) {
    return "Property"
  }

  return null
}

function hoverContentText(hover: Hover | null): string {
  if (!hover) return ""

  const addMarkedString = (value: unknown): string => {
    if (typeof value === "string") return value
    const record = asRecord(value)
    if (record && typeof record.value === "string") return record.value
    return ""
  }

  if (typeof hover.contents === "string") return hover.contents
  if (Array.isArray(hover.contents)) return hover.contents.map(addMarkedString).join("\n")

  const record = asRecord(hover.contents)
  if (record && typeof record.value === "string") return record.value
  return addMarkedString(hover.contents)
}

function shouldProbeMembers(hover: Hover | null, forceProbe: boolean): boolean {
  if (forceProbe) return true
  const text = hoverContentText(hover)
  if (!text.trim()) return false
  if (/\bfunction\s+[$A-Z_a-z][$\w]*\s*\(/.test(text)) return false
  if (/\b(?:const|let|var|parameter)\s+[$A-Z_a-z][$\w]*\s*:/.test(text)) return true
  if (/\(property\)\s+[\s\S]*:/.test(text)) return true
  return false
}

function hoverCompletenessHints(hover: Hover | null): string[] {
  const text = hoverContentText(hover).replace(/\s+/g, " ").trim()
  if (!text) return []

  const hints: string[] = []
  const complexPatterns = [
    /\b(?:Pick|Omit|Partial|Required|Readonly|Record|Extract|Exclude|ReturnType|Parameters|ConstructorParameters|InstanceType|Awaited|NonNullable)\s*</,
    /\bkeyof\b/,
    /\binfer\b/,
    /\bextends\b[^?]*\?/,
    /\[[^\]]+\s+in\s+keyof\b/,
    /[$A-Z_a-z0-9_>)\]]\s*&\s*[$A-Z_a-z({]/,
    /[$A-Z_a-z0-9_>)\]]\s*\|\s*[$A-Z_a-z({]/,
  ]

  if (complexPatterns.some((pattern) => pattern.test(text))) {
    hints.push("hover shows a complex alias/generic/union type that LSP may not fully expand")
  }

  const namedReturn = text.match(/\)\s*:\s*([A-Z_$][\w$]*)\b/)
  if (namedReturn?.[1] && !PRIMITIVE_TYPE_NAMES.has(namedReturn[1])) {
    hints.push("hover shows a named return type rather than the fully expanded return shape")
  }

  return hints
}

function isIdentifierCharacter(ch: string | undefined): boolean {
  return !!ch && /[$A-Z_a-z0-9_]/.test(ch)
}

function offsetAt(sourceText: string, position: Position): number | null {
  const lines = sourceText.split("\n")
  if (position.line < 0 || position.line >= lines.length) return null
  const lineText = lines[position.line] ?? ""
  if (position.character < 0 || position.character > lineText.length) return null

  let offset = 0
  for (let i = 0; i < position.line; i++) {
    offset += (lines[i]?.length ?? 0) + 1
  }
  return offset + position.character
}

function findIdentifierEndPosition(
  sourceText: string,
  line: number,
  character: number,
): Position | null {
  const lines = sourceText.split("\n")
  const lineIndex = line - 1
  if (lineIndex < 0 || lineIndex >= lines.length) return null
  const lineText = lines[lineIndex] ?? ""
  let start = Math.min(Math.max(character, 0), lineText.length)

  if (!isIdentifierCharacter(lineText[start]) && start > 0 && isIdentifierCharacter(lineText[start - 1])) {
    start--
  }

  while (start > 0 && isIdentifierCharacter(lineText[start - 1])) {
    start--
  }

  let end = start
  while (end < lineText.length && isIdentifierCharacter(lineText[end])) {
    end++
  }

  if (end === start) {
    return { line: lineIndex, character: Math.min(Math.max(character, 0), lineText.length) }
  }

  return { line: lineIndex, character: end }
}

function getProbePosition(
  sourceText: string,
  hover: Hover | null,
  line: number,
  character: number,
): Position | null {
  if (hover?.range?.end && offsetAt(sourceText, hover.range.end) !== null) {
    return hover.range.end
  }
  return findIdentifierEndPosition(sourceText, line, character)
}

function toHoverMember(item: CompletionItemLike, kind: MemberKind): HoverMember {
  return {
    name: completionItemLabel(item),
    kind,
    detail: completionItemDetail(item),
    documentation: documentationToText(item.documentation),
    deprecated: isDeprecatedCompletionItem(item),
  }
}

async function resolveCompletionMembers(
  client: LSPClient,
  completion: unknown,
  maxMembers: number,
): Promise<Pick<HoverMemberDetails, "members" | "totalMembers" | "isIncomplete" | "truncated" | "resolveFailures" | "missingDetails">> {
  const normalized = normalizeCompletionResult(completion)
  const seen = new Set<string>()
  const candidates: Array<{ item: CompletionItemLike; kind: MemberKind }> = []

  for (const item of normalized.items) {
    const kind = classifyCompletionItem(item)
    if (!kind) continue
    const label = completionItemLabel(item)
    if (!label) continue
    const key = `${kind}:${label}`
    if (seen.has(key)) continue
    seen.add(key)
    candidates.push({ item, kind })
  }

  const selected = candidates.slice(0, maxMembers)
  const members: HoverMember[] = []
  let resolveFailures = 0

  for (const candidate of selected) {
    let resolved = candidate.item
    try {
      const resolvedItem = await client.resolveCompletionItem(candidate.item)
      if (isCompletionItemLike(resolvedItem)) {
        resolved = resolvedItem
      }
    } catch {
      resolveFailures++
    }
    members.push(toHoverMember(resolved, classifyCompletionItem(resolved) ?? candidate.kind))
  }

  return {
    members,
    totalMembers: candidates.length,
    isIncomplete: normalized.isIncomplete,
    truncated: candidates.length > selected.length,
    resolveFailures,
    missingDetails: members.filter((member) => !member.detail).length,
  }
}

function buildMemberHints(
  details: Pick<HoverMemberDetails, "totalMembers" | "members" | "isIncomplete" | "truncated" | "resolveFailures" | "missingDetails">,
  maxMembers: number,
): string[] {
  const hints: string[] = []
  if (details.isIncomplete) {
    hints.push("LSP reported an incomplete member list")
  }
  if (details.truncated) {
    hints.push(`member list was truncated at ${maxMembers}/${details.totalMembers} entries`)
  }
  if (details.resolveFailures > 0) {
    hints.push(`${details.resolveFailures} member detail request(s) failed`)
  }
  if (details.missingDetails > 0) {
    hints.push(`${details.missingDetails} member(s) did not include full detail text from LSP`)
  }
  return hints
}

async function collectHoverMembers(opts: {
  client: LSPClient
  filePath: string
  hover: Hover | null
  line: number
  character: number
  maxMembers: number
  forceProbe?: boolean
  sourceText?: string
}): Promise<HoverMemberDetails | null> {
  const baseHints = hoverCompletenessHints(opts.hover)
  if (!shouldProbeMembers(opts.hover, opts.forceProbe ?? false)) {
    return baseHints.length > 0
      ? {
          members: [],
          totalMembers: 0,
          isIncomplete: false,
          truncated: false,
          resolveFailures: 0,
          missingDetails: 0,
          hints: baseHints,
        }
      : null
  }

  let sourceText = opts.sourceText
  try {
    sourceText ??= readFileSync(opts.filePath, "utf-8")
  } catch (e) {
    return {
      members: [],
      totalMembers: 0,
      isIncomplete: false,
      truncated: false,
      resolveFailures: 0,
      missingDetails: 0,
      hints: [
        ...baseHints,
        `could not read source text for member probing: ${e instanceof Error ? e.message : String(e)}`,
      ],
    }
  }

  const position = getProbePosition(sourceText, opts.hover, opts.line, opts.character)
  const offset = position ? offsetAt(sourceText, position) : null
  if (!position || offset === null) {
    return {
      members: [],
      totalMembers: 0,
      isIncomplete: false,
      truncated: false,
      resolveFailures: 0,
      missingDetails: 0,
      hints: [...baseHints, "could not identify the expression boundary for member probing"],
    }
  }

  const editedText = sourceText.slice(0, offset) + "." + sourceText.slice(offset)
  let didApply = false
  try {
    await opts.client.applyInMemoryEdit(opts.filePath, editedText)
    didApply = true
    const completion = await opts.client.completion(
      opts.filePath,
      position.line + 1,
      position.character + 1,
      2,
      ".",
      false,
    )
    const memberDetails = await resolveCompletionMembers(opts.client, completion, opts.maxMembers)
    return {
      ...memberDetails,
      hints: [
        ...baseHints,
        ...buildMemberHints(memberDetails, opts.maxMembers),
      ],
    }
  } catch (e) {
    return {
      members: [],
      totalMembers: 0,
      isIncomplete: false,
      truncated: false,
      resolveFailures: 0,
      missingDetails: 0,
      hints: [
        ...baseHints,
        `LSP member completion failed: ${e instanceof Error ? e.message : String(e)}`,
      ],
    }
  } finally {
    if (didApply) {
      try {
        await opts.client.revertInMemoryEdit(opts.filePath)
      } catch {}
    }
  }
}

function isValidIdentifierName(name: string): boolean {
  return /^[$A-Z_a-z][$\w]*$/.test(name)
}

function buildPackageProbeContent(packageName: string, symbolName: string): string | null {
  const specifier = JSON.stringify(packageName)
  const importLine = symbolName === "default"
    ? `import type __HoverTarget from ${specifier}`
    : isValidIdentifierName(symbolName)
      ? `import type { ${symbolName} as __HoverTarget } from ${specifier}`
      : null

  if (!importLine) return null

  return [
    importLine,
    "",
    "declare const __hover_value: __HoverTarget",
    "__hover_value",
    "",
  ].join("\n")
}

function canProbePackageSymbolMembers(kind: UnifiedSymbolKind): boolean {
  return kind === "Class" || kind === "Interface" || kind === "TypeAlias"
}

async function collectPackageSymbolMembers(opts: {
  packageName: string
  symbolName: string
  kind: UnifiedSymbolKind
  workspaceRoot: string
  maxMembers: number
}): Promise<HoverMemberDetails | null> {
  if (!canProbePackageSymbolMembers(opts.kind)) return null
  const content = buildPackageProbeContent(opts.packageName, opts.symbolName)
  if (!content) {
    return {
      members: [],
      totalMembers: 0,
      isIncomplete: false,
      truncated: false,
      resolveFailures: 0,
      missingDetails: 0,
      hints: ["could not create a type probe for this exported symbol name"],
    }
  }

  try {
    return await withProbeFile(opts.workspaceRoot, content, async (probePath) => {
      return await withLspClient(probePath, async (client) => {
        const hover = (await client.hover(probePath, 4, 1)) as Hover | null
        return await collectHoverMembers({
          client,
          filePath: probePath,
          hover,
          line: 4,
          character: 1,
          maxMembers: opts.maxMembers,
          forceProbe: true,
          sourceText: content,
        })
      })
    })
  } catch (e) {
    return {
      members: [],
      totalMembers: 0,
      isIncomplete: false,
      truncated: false,
      resolveFailures: 0,
      missingDetails: 0,
      hints: [`LSP package member probe failed: ${e instanceof Error ? e.message : String(e)}`],
    }
  }
}

function pushUnique(target: string[], values: string[]): void {
  for (const value of values) {
    const normalized = value.trim()
    if (normalized && !target.includes(normalized)) target.push(normalized)
  }
}

function formatMember(member: HoverMember): string {
  const lines = [
    `- ${member.name}${member.deprecated ? " [deprecated]" : ""}${member.detail ? `: ${member.detail}` : ""}`,
  ]
  if (member.documentation) {
    const docLines = member.documentation.split("\n")
    lines.push(`  Documentation: ${docLines[0] ?? ""}`)
    for (const line of docLines.slice(1)) {
      lines.push(`    ${line}`)
    }
  }
  return lines.join("\n")
}

function memberGroups(details: HoverMemberDetails | null | undefined): HoverMemberGroups | undefined {
  if (!details) return undefined
  return {
    methods: details.members.filter((member) => member.kind === "Method"),
    properties: details.members.filter((member) => member.kind === "Property"),
  }
}

function memberStats(details: HoverMemberDetails | null | undefined): HoverMemberStats | undefined {
  if (!details) return undefined
  const groups = memberGroups(details) ?? { methods: [], properties: [] }
  return {
    totalMembers: details.totalMembers,
    shownMembers: details.members.length,
    methodCount: groups.methods.length,
    propertyCount: groups.properties.length,
    isIncomplete: details.isIncomplete,
    truncated: details.truncated,
    resolveFailures: details.resolveFailures,
    missingDetails: details.missingDetails,
  }
}

function buildReadFileAction(
  filePath: string | undefined,
  reason: string,
  line?: number,
  character?: number,
): ToolNextAction | null {
  if (!filePath) return null
  return {
    type: "read_file",
    priority: "high",
    reason,
    filePath,
    line,
    character,
  }
}

function memberNextActions(
  details: HoverMemberDetails | null | undefined,
  filePath: string | undefined,
  line?: number,
  character?: number,
): ToolNextAction[] {
  if (!details) return []
  const needsFile =
    details.hints.length > 0 ||
    details.truncated ||
    details.isIncomplete ||
    details.resolveFailures > 0 ||
    details.missingDetails > 0
  const action = needsFile
    ? buildReadFileAction(
        filePath,
        "Type/member information may be incomplete; read the declaration and related imported/base types for full context.",
        line,
        character,
      )
    : null
  return action ? [action] : []
}

function formatMemberDetails(
  details: HoverMemberDetails | null | undefined,
  opts: {
    source?: string
    definition?: string
  },
): string | null {
  if (!details) return null

  const lines: string[] = []
  const methods = details.members.filter((member) => member.kind === "Method")
  const properties = details.members.filter((member) => member.kind === "Property")

  if (details.members.length > 0) {
    lines.push("Members:")
    if (methods.length > 0) {
      lines.push("Methods:")
      for (const member of methods) lines.push(formatMember(member))
    }
    if (properties.length > 0) {
      lines.push("Properties:")
      for (const member of properties) lines.push(formatMember(member))
    }
    if (details.truncated) {
      lines.push(`(Truncated: showed ${details.members.length}/${details.totalMembers} members.)`)
    }
  }

  const hints: string[] = []
  pushUnique(hints, details.hints)
  if (hints.length > 0) {
    const location = opts.definition ?? opts.source
    const locationText = location ? ` Start with ${location}.` : ""
    lines.push(
      `Hint: Type/member information may be incomplete (${hints.join("; ")}). ` +
        `Read the Definition/Source file above and related imported or base type declarations for the full type.${locationText}`,
    )
  }

  return lines.length > 0 ? lines.join("\n") : null
}

function formatHoverBlock(
  hover: Hover | null,
  opts: {
    source?: string
    definition?: string
    members?: HoverMemberDetails | null
  } = {},
): string {
  const lines: string[] = []
  if (opts.source) lines.push(`Source: ${opts.source}`)
  if (opts.definition) lines.push(`Definition: ${opts.definition}`)
  lines.push("---")
  lines.push(formatHover(hover))
  const memberBlock = formatMemberDetails(opts.members, opts)
  if (memberBlock) {
    lines.push("")
    lines.push(memberBlock)
  }
  return lines.join("\n")
}

export const lsp_hover: ToolDefinition = tool({
  description:
    "Show documentation, signature and type for a symbol (JSDoc, @deprecated, generic params, return type). " +
    "Use when: 'what is the signature of X?', 'does this have a doc comment?', 'what type does Y return?'. " +
    "Two input modes: (1) classic filePath + line + character for a symbol already present in source, or " +
    "(2) packageName + symbolName to hover a declaration inside an installed package WITHOUT needing an existing usage. " +
    "packageName supports exact name, array, glob (e.g. '@scope/*'), or regex literal '/.../'. " +
    "Not for: listing all exports of a package (use lsp_package_exports), jumping to source (use lsp_goto_definition), " +
    "finding usages (use lsp_find_references), or free-text code search (use ast_grep_search).",
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
    maxPackages: tool.schema.number().min(1).max(500).optional(),
    includeMembers: tool.schema.boolean().optional(),
    maxMembers: tool.schema.number().min(1).max(500).optional(),
  },
  execute: async (args, _context) => {
    try {
      const includeMembers = args.includeMembers ?? true
      const maxMembers = args.maxMembers ?? DEFAULT_MAX_MEMBERS
      if (args.packageName) {
        if (!args.symbolName) {
          return errorResult("lsp_hover", "symbolName is required when packageName is provided")
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
          return errorResult("lsp_hover", `Symbol "${args.symbolName}" not found in package(s) matching: ${names}`)
        }

        const warnings: string[] = []
        if (args.filePath || args.line !== undefined || args.character !== undefined) {
          warnings.push("filePath/line/character ignored because packageName was provided.")
        }

        const blocks: HoverBlockData[] = []
        const nextActions: ToolNextAction[] = []
        const hints: string[] = []
        let truncated = false
        for (const loc of locations) {
          try {
            const hover = await withLspClient(loc.filePath, async (client) => {
              return (await client.hover(loc.filePath, loc.line, loc.character)) as Hover | null
            })
            const members = includeMembers
              ? await collectPackageSymbolMembers({
                  packageName: loc.pkg,
                  symbolName: args.symbolName,
                  kind: loc.kind,
                  workspaceRoot,
                  maxMembers,
                })
              : null
            const source = loc.nodeModulesRoot
              ? toNodeModulesRelativePath(loc.filePath, loc.nodeModulesRoot)
              : loc.filePath
            const displaySourceRef = `${source}:${loc.line}:${loc.character}`
            const sourceRef = `${loc.filePath}:${loc.line}:${loc.character}`
            const hoverText = formatHover(hover)
            pushUnique(hints, members?.hints ?? [])
            truncated = truncated || (members?.truncated ?? false)
            nextActions.push(...memberNextActions(members, loc.filePath, loc.line, loc.character))
            blocks.push({
              packageName: loc.pkg,
              source: sourceRef,
              displaySource: displaySourceRef,
              definition: sourceRef,
              displayDefinition: displaySourceRef,
              hoverText,
              members: memberGroups(members),
              memberStats: memberStats(members),
              memberHints: members?.hints,
              text: `${loc.pkg} :: ${args.symbolName}\n` +
                formatHoverBlock(hover, { source: displaySourceRef, definition: displaySourceRef, members }),
            })
          } catch (e) {
            warnings.push(`[${loc.pkg}] ${e instanceof Error ? e.message : String(e)}`)
            blocks.push({
              packageName: loc.pkg,
              source: `${loc.filePath}:${loc.line}:${loc.character}`,
              displaySource: `${loc.filePath}:${loc.line}:${loc.character}`,
              hoverText: "",
              text: `${loc.pkg} :: ${args.symbolName}\n` +
                `Source: ${loc.filePath}:${loc.line}:${loc.character}\n` +
                `---\nError: ${e instanceof Error ? e.message : String(e)}`,
            })
          }
        }

        return okResult<HoverData>(
          "lsp_hover",
          `Found hover information for ${blocks.length} package symbol match(es).`,
          {
            input: {
              packageName: args.packageName,
              symbolName: args.symbolName,
              includeMembers,
              maxMembers,
            },
            blocks,
          },
          { warnings, hints, nextActions, truncated },
        )
      }

      if (!args.filePath || args.line === undefined || args.character === undefined) {
        return errorResult("lsp_hover", "provide either packageName + symbolName, or filePath + line + character")
      }

      const result = await withLspClient(args.filePath, async (client) => {
        const hover = (await client.hover(args.filePath!, args.line!, args.character!)) as Hover | null
        const definition = firstDefinitionLocation(
          await client.definition(args.filePath!, args.line!, args.character!),
        )
        const members = includeMembers
          ? await collectHoverMembers({
              client,
              filePath: args.filePath!,
              hover,
              line: args.line!,
              character: args.character!,
              maxMembers,
            })
          : null
        return { hover, definition, members }
      })

      const definitionRef = result.definition ? locationToRef(result.definition) : undefined
      const definition = result.definition ? formatLocation(result.definition) : undefined
      const hoverText = formatHover(result.hover)
      const text = formatHoverBlock(result.hover, {
        source: `${args.filePath}:${args.line}:${args.character}`,
        definition,
        members: result.members,
      })
      const nextActions = memberNextActions(
        result.members,
        definitionRef?.filePath ?? args.filePath,
        definitionRef?.line,
        definitionRef?.character,
      )
      return okResult<HoverData>(
        "lsp_hover",
        `Found hover information at ${args.filePath}:${args.line}:${args.character}.`,
        {
          input: {
            filePath: args.filePath,
            line: args.line,
            character: args.character,
            includeMembers,
            maxMembers,
          },
          blocks: [{
            source: `${args.filePath}:${args.line}:${args.character}`,
            definition,
            hoverText,
            members: memberGroups(result.members),
            memberStats: memberStats(result.members),
            memberHints: result.members?.hints,
            text,
          }],
        },
        {
          truncated: result.members?.truncated ?? false,
          hints: result.members?.hints ?? [],
          nextActions,
        },
      )
    } catch (e) {
      return errorResult("lsp_hover", e instanceof Error ? e.message : String(e))
    }
  },
})
