import { afterEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { dirname, join } from "path"

import type { PluginInput } from "@opencode-ai/plugin"
import { createAstGrepTools } from "../src/ast-grep/tools"

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "standalone-ast-grep-tools-"))
  tempDirs.push(dir)
  return dir
}

function writeProjectFile(root: string, relativePath: string, content: string): string {
  const filePath = join(root, relativePath)
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, content, "utf-8")
  return filePath
}

function createPluginInput(directory: string): PluginInput {
  return { directory } as PluginInput
}

function createToolContext() {
  const metadataCalls: Array<{ metadata: { output: string } }> = []
  return {
    context: {
      metadata(input: { metadata: { output: string } }) {
        metadataCalls.push(input)
      },
    },
    metadataCalls,
  }
}

function outputToText(output: Awaited<ReturnType<ReturnType<typeof createAstGrepTools>[string]["execute"]>>): string {
  return typeof output === "string" ? output : output.output
}

function outputToJson(output: Awaited<ReturnType<ReturnType<typeof createAstGrepTools>[string]["execute"]>>) {
  return JSON.parse(outputToText(output))
}

describe("createAstGrepTools", () => {
  it("uses real ast_grep_search and returns hint for unmatched python pattern", async () => {
    const projectDir = createTempDir()
    writeProjectFile(projectDir, "sample.py", "value = 1\n")

    const tools = createAstGrepTools(createPluginInput(projectDir))
    const { context, metadataCalls } = createToolContext()
    const output = await tools.ast_grep_search.execute(
      {
        pattern: "def $FUNC($$$):",
        lang: "python",
      },
      context as never,
    )
    const outputText = outputToText(output)
    const result = outputToJson(output)

    expect(result.ok).toBe(true)
    expect(result.tool).toBe("ast_grep_search")
    expect(result.summary).toBe("No matches found.")
    expect(result.data.total).toBe(0)
    expect(result.data.matches).toEqual([])
    expect(result.hints).toContain('Hint: Remove trailing colon. Try: "def $FUNC($$$)"')
    expect(metadataCalls[0]?.metadata.output).toBe(outputText)
  })

  it("uses real ast_grep_replace to rewrite source files", async () => {
    const projectDir = createTempDir()
    const filePath = writeProjectFile(
      projectDir,
      "src/index.ts",
      "const value = 1;\nconsole.log(value);\n",
    )

    const tools = createAstGrepTools(createPluginInput(projectDir))
    const { context, metadataCalls } = createToolContext()
    const output = await tools.ast_grep_replace.execute(
      {
        pattern: "console.log($MSG)",
        rewrite: "logger.info($MSG)",
        lang: "typescript",
        dryRun: false,
      },
      context as never,
    )
    const outputText = outputToText(output)
    const result = outputToJson(output)

    expect(result.ok).toBe(true)
    expect(result.tool).toBe("ast_grep_replace")
    expect(result.summary).toBe("1 replacement(s) applied.")
    expect(result.data.applied).toBe(true)
    expect(result.data.total).toBe(1)
    expect(result.data.input.rewrite).toBe("logger.info($MSG)")
    expect(result.data.rewriteTemplate).toBe("logger.info($MSG)")
    expect(result.data.afterTextReliable).toBe(false)
    expect(result.data.matches[0].filePath).toBe(filePath)
    expect(result.data.matches[0].text).toBe("console.log(value)")
    expect(readFileSync(filePath, "utf-8")).toContain("logger.info(value)")
    expect(readFileSync(filePath, "utf-8")).not.toContain("console.log(value)")
    expect(metadataCalls[0]?.metadata.output).toBe(outputText)
  })

  it("defaults ast_grep_replace to dry-run and preserves source files", async () => {
    const projectDir = createTempDir()
    const filePath = writeProjectFile(
      projectDir,
      "src/index.ts",
      "const value = 1;\nconsole.log(value);\n",
    )

    const tools = createAstGrepTools(createPluginInput(projectDir))
    const { context } = createToolContext()
    const output = await tools.ast_grep_replace.execute(
      {
        pattern: "console.log($MSG)",
        rewrite: "logger.info($MSG)",
        lang: "typescript",
      },
      context as never,
    )
    const result = outputToJson(output)

    expect(result.summary).toBe("1 replacement(s) would be made.")
    expect(result.data.applied).toBe(false)
    expect(result.hints).toContain("Review data.matches, then rerun with dryRun=false to apply these replacements.")
    expect(readFileSync(filePath, "utf-8")).toContain("console.log(value)")
  })
})
