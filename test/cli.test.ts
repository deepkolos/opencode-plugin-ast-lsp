import { afterAll, afterEach, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { dirname, join } from "path"

const tempDirs: string[] = []
const packWorkspaces: string[] = []
let packedCliTarballPath: string | undefined

type CliTestMode = "source" | "bunx-pack" | "npx-pack"
const CLI_TEST_TIMEOUT_MS = 60000
const SOURCE_CLI_ENTRY_PERF_SAMPLE_COUNT = 3

interface CliRunResult {
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

afterAll(() => {
  for (const dir of packWorkspaces.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
  packedCliTarballPath = undefined
})

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ast-lsp-cli-"))
  tempDirs.push(dir)
  return dir
}

function writeProjectFile(root: string, relativePath: string, content: string): string {
  const filePath = join(root, relativePath)
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, content, "utf-8")
  return filePath
}

function getCliTestMode(): CliTestMode {
  if (process.env.AST_LSP_CLI_TEST_MODE === "bunx-pack") return "bunx-pack"
  if (process.env.AST_LSP_CLI_TEST_MODE === "npx-pack") return "npx-pack"
  return "source"
}

function getCliEntryPerfBudgetMs(): number {
  const override = process.env.AST_LSP_CLI_ENTRY_PERF_BUDGET_MS
  if (override) {
    const parsed = Number(override)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }

  const mode = getCliTestMode()
  if (mode === "source") return 2500
  if (mode === "bunx-pack") return 20000
  return 30000
}

function formatDurationMs(durationMs: number): string {
  return `${durationMs.toFixed(1)}ms`
}

function summarizeDurations(samples: number[]): { min: number; max: number; avg: number } {
  return {
    min: Math.min(...samples),
    max: Math.max(...samples),
    avg: samples.reduce((sum, sample) => sum + sample, 0) / samples.length,
  }
}

async function getPackedCliTarballPath(): Promise<string> {
  if (packedCliTarballPath) return packedCliTarballPath

  const workspace = mkdtempSync(join(tmpdir(), "ast-lsp-pack-"))
  packWorkspaces.push(workspace)
  const proc = Bun.spawn([
    process.execPath,
    "scripts/pack-local.cjs",
    "--no-build",
    "--json",
    "--out-dir",
    workspace,
  ], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      npm_config_registry: process.env.npm_config_registry || "https://registry.npmjs.org/",
    },
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (exitCode !== 0) {
    throw new Error(`pack-local failed:\n${stderr || stdout}`)
  }

  const packed = JSON.parse(stdout) as { tarballPath?: string }
  if (!packed.tarballPath) throw new Error(`pack-local did not report tarballPath:\n${stdout}`)
  if (!existsSync(packed.tarballPath)) throw new Error(`Packed CLI tarball not found: ${packed.tarballPath}`)
  packedCliTarballPath = packed.tarballPath
  return packedCliTarballPath
}

async function runCli(args: string[]): Promise<CliRunResult> {
  const mode = getCliTestMode()
  const cleanCwd = createTempDir()
  const command = mode === "source"
    ? [process.execPath, "src/cli.ts", ...args]
    : mode === "bunx-pack"
    ? ["bunx", "--bun", "--package", await getPackedCliTarballPath(), "ast-lsp", ...args]
    : ["npx", "--yes", "--loglevel", "error", "--package", await getPackedCliTarballPath(), "ast-lsp", ...args]
  const start = performance.now()
  const proc = Bun.spawn(command, {
    cwd: mode === "source" ? process.cwd() : cleanCwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      npm_config_registry: process.env.npm_config_registry || "https://registry.npmjs.org/",
    },
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, stdout, stderr, durationMs: performance.now() - start }
}

describe("CLI", () => {
  it("keeps lightweight entrypoints within the startup budget", async () => {
    const mode = getCliTestMode()
    const budgetMs = getCliEntryPerfBudgetMs()
    const sampleCount = mode === "source" ? SOURCE_CLI_ENTRY_PERF_SAMPLE_COUNT : 1
    const scenarios = [
      { name: "help", args: ["--help"] },
      { name: "list-tools", args: ["list-tools", "--json"] },
    ]

    const summaries: string[] = []
    for (const scenario of scenarios) {
      const samples: number[] = []
      for (let i = 0; i < sampleCount; i++) {
        const result = await runCli(scenario.args)
        expect(result.exitCode).toBe(0)
        samples.push(result.durationMs)
      }

      const summary = summarizeDurations(samples)
      summaries.push(
        `${scenario.name}: min=${formatDurationMs(summary.min)}, avg=${formatDurationMs(summary.avg)}, max=${formatDurationMs(summary.max)}`,
      )
      expect(summary.max).toBeLessThanOrEqual(budgetMs)
    }

    console.log(`CLI entry timings (${mode}, budget=${formatDurationMs(budgetMs)}): ${summaries.join("; ")}`)
  }, CLI_TEST_TIMEOUT_MS)

  it("lists public tools as JSON", async () => {
    const result = await runCli(["list-tools", "--json"])
    const output = JSON.parse(result.stdout)

    expect(result.exitCode).toBe(0)
    const names = output.tools.map((item: { name: string }) => item.name)
    expect(names).toContain("ast_grep_search")
    expect(names).toContain("lsp_inspect")
    expect(names).toContain("lsp_rename")
    expect(names).not.toContain("lsp_hover")
  }, CLI_TEST_TIMEOUT_MS)

  it("runs ast_grep_search with JSON input", async () => {
    const root = createTempDir()
    const filePath = writeProjectFile(root, "src/index.ts", "const value = 1;\nconsole.log(value);\n")

    const result = await runCli([
      "run",
      "ast_grep_search",
      "--cwd",
      root,
      "--input",
      JSON.stringify({
        pattern: "console.log($MSG)",
        lang: "typescript",
        paths: ["src"],
      }),
    ])
    const output = JSON.parse(result.stdout)

    expect(result.exitCode).toBe(0)
    expect(output.ok).toBe(true)
    expect(output.tool).toBe("ast_grep_search")
    expect([filePath, "src/index.ts"]).toContain(output.data.matches[0].filePath)
    expect(output.data.matches[0].text).toBe("console.log(value)")
  }, CLI_TEST_TIMEOUT_MS)

  it("returns exit code 2 for invalid JSON input", async () => {
    const root = createTempDir()
    const result = await runCli([
      "run",
      "ast_grep_search",
      "--cwd",
      root,
      "--input",
      "{bad",
    ])
    const output = JSON.parse(result.stdout)

    expect(result.exitCode).toBe(2)
    expect(output.ok).toBe(false)
    expect(output.summary).toContain("invalid JSON input")
  }, CLI_TEST_TIMEOUT_MS)
})
