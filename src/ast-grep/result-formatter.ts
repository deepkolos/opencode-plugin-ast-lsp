import type { CliLanguage, CliMatch, SgResult } from "./types"

export interface AstGrepInput {
  pattern: string
  lang: CliLanguage
  paths: string[]
  globs?: string[]
}

export interface AstGrepSearchInput extends AstGrepInput {
  context?: number
}

export interface AstGrepReplaceInput extends AstGrepInput {
  rewrite: string
  dryRun: boolean
}

export interface AstGrepMatchInfo {
  filePath: string
  language: string
  location: {
    line: number
    column: number
  }
  range: {
    startLine: number
    startColumn: number
    endLine: number
    endColumn: number
  }
  byteRange: {
    start: number
    end: number
  }
  text: string
  lines: string
  leadingChars: number
  trailingChars: number
}

export interface AstGrepSearchData {
  input: AstGrepSearchInput
  total: number
  shown: number
  matches: AstGrepMatchInfo[]
  truncatedReason?: SgResult["truncatedReason"]
}

export interface AstGrepReplaceData {
  input: AstGrepReplaceInput
  rewriteTemplate: string
  total: number
  shown: number
  applied: boolean
  afterTextReliable: boolean
  matches: AstGrepMatchInfo[]
  truncatedReason?: SgResult["truncatedReason"]
}

function matchToInfo(match: CliMatch): AstGrepMatchInfo {
  return {
    filePath: match.file,
    language: match.language,
    location: {
      line: match.range.start.line + 1,
      column: match.range.start.column + 1,
    },
    range: {
      startLine: match.range.start.line + 1,
      startColumn: match.range.start.column + 1,
      endLine: match.range.end.line + 1,
      endColumn: match.range.end.column + 1,
    },
    byteRange: {
      start: match.range.byteOffset.start,
      end: match.range.byteOffset.end,
    },
    text: match.text,
    lines: match.lines.trim(),
    leadingChars: match.charCount.leading,
    trailingChars: match.charCount.trailing,
  }
}

export function buildSearchResultData(result: SgResult, input: AstGrepSearchInput): AstGrepSearchData {
  return {
    input,
    total: result.totalMatches,
    shown: result.matches.length,
    matches: result.matches.map(matchToInfo),
    truncatedReason: result.truncatedReason,
  }
}

export function buildReplaceResultData(
  result: SgResult,
  input: AstGrepReplaceInput,
): AstGrepReplaceData {
  return {
    input,
    rewriteTemplate: input.rewrite,
    total: result.totalMatches,
    shown: result.matches.length,
    applied: !input.dryRun && result.matches.length > 0,
    afterTextReliable: false,
    matches: result.matches.map(matchToInfo),
    truncatedReason: result.truncatedReason,
  }
}

export function formatSearchResult(result: SgResult): string {
  if (result.error) {
    return `Error: ${result.error}`
  }

  if (result.matches.length === 0) {
    return "No matches found"
  }

  const lines: string[] = []

  if (result.truncated) {
    const reason = result.truncatedReason === "max_matches"
      ? `showing first ${result.matches.length} of ${result.totalMatches}`
      : result.truncatedReason === "max_output_bytes"
      ? "output exceeded 1MB limit"
      : "search timed out"
    lines.push(`[TRUNCATED] Results truncated (${reason})\n`)
  }

  lines.push(`Found ${result.matches.length} match(es)${result.truncated ? ` (truncated from ${result.totalMatches})` : ""}:\n`)

  for (const match of result.matches) {
    const loc = `${match.file}:${match.range.start.line + 1}:${match.range.start.column + 1}`
    lines.push(`${loc}`)
    lines.push(`  ${match.lines.trim()}`)
    lines.push("")
  }

  return lines.join("\n")
}

export function formatReplaceResult(result: SgResult, isDryRun: boolean): string {
  if (result.error) {
    return `Error: ${result.error}`
  }

  if (result.matches.length === 0) {
    return "No matches found to replace"
  }

  const prefix = isDryRun ? "[DRY RUN] " : ""
  const lines: string[] = []

  if (result.truncated) {
    const reason = result.truncatedReason === "max_matches"
      ? `showing first ${result.matches.length} of ${result.totalMatches}`
      : result.truncatedReason === "max_output_bytes"
      ? "output exceeded 1MB limit"
      : "search timed out"
    lines.push(`[TRUNCATED] Results truncated (${reason})\n`)
  }

  lines.push(`${prefix}${result.matches.length} replacement(s):\n`)

  for (const match of result.matches) {
    const loc = `${match.file}:${match.range.start.line + 1}:${match.range.start.column + 1}`
    lines.push(`${loc}`)
    lines.push(`  ${match.text}`)
    lines.push("")
  }

  if (isDryRun) {
    lines.push("Use dryRun=false to apply changes")
  }

  return lines.join("\n")
}
