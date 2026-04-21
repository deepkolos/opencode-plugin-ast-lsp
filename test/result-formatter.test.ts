import { describe, expect, it } from "bun:test"

import { formatReplaceResult, formatSearchResult } from "../src/ast-grep/result-formatter"
import type { CliMatch, SgResult } from "../src/ast-grep/types"

function createMatch(overrides: Partial<CliMatch> = {}): CliMatch {
  return {
    text: "console.log(value)",
    file: "src/index.ts",
    lines: "  console.log(value)  ",
    language: "typescript",
    charCount: { leading: 2, trailing: 2 },
    range: {
      byteOffset: { start: 0, end: 18 },
      start: { line: 2, column: 4 },
      end: { line: 2, column: 22 },
    },
    ...overrides,
  }
}

function createResult(overrides: Partial<SgResult> = {}): SgResult {
  return {
    matches: [],
    totalMatches: 0,
    truncated: false,
    ...overrides,
  }
}

describe("formatSearchResult", () => {
  it("returns error message when ast-grep fails", () => {
    const output = formatSearchResult(createResult({ error: "binary missing" }))

    expect(output).toBe("Error: binary missing")
  })

  it("returns no matches message when result is empty", () => {
    const output = formatSearchResult(createResult())

    expect(output).toBe("No matches found")
  })

  it("formats truncated search results with file location and trimmed code", () => {
    const output = formatSearchResult(
      createResult({
        matches: [createMatch()],
        totalMatches: 3,
        truncated: true,
        truncatedReason: "max_matches",
      }),
    )

    expect(output).toContain("[TRUNCATED] Results truncated (showing first 1 of 3)")
    expect(output).toContain("Found 1 match(es) (truncated from 3):")
    expect(output).toContain("src/index.ts:3:5")
    expect(output).toContain("console.log(value)")
  })
})

describe("formatReplaceResult", () => {
  it("formats dry-run replacements and shows apply guidance", () => {
    const output = formatReplaceResult(
      createResult({
        matches: [createMatch({ text: "logger.info(value)" })],
        totalMatches: 1,
      }),
      true,
    )

    expect(output).toContain("[DRY RUN] 1 replacement(s):")
    expect(output).toContain("src/index.ts:3:5")
    expect(output).toContain("logger.info(value)")
    expect(output).toContain("Use dryRun=false to apply changes")
  })

  it("formats non-dry-run truncated replacements without dry-run guidance", () => {
    const output = formatReplaceResult(
      createResult({
        matches: [createMatch()],
        totalMatches: 10,
        truncated: true,
        truncatedReason: "timeout",
      }),
      false,
    )

    expect(output).toContain("[TRUNCATED] Results truncated (search timed out)")
    expect(output).toContain("1 replacement(s):")
    expect(output).not.toContain("Use dryRun=false to apply changes")
  })
})
