import { spawn } from "bun"
import { existsSync } from "fs"

import {
  DEFAULT_TIMEOUT_MS,
} from "./constants"
import { ensureAstGrepBinary, getCachedBinaryPath } from "./downloader"
import type { CliLanguage, SgResult } from "./types"

import { createSgResultFromStdout } from "./sg-compact-json-output"

let cachedCliPath: string | null = null

function getSgCliPath(): string | null {
  if (cachedCliPath) return cachedCliPath
  
  const cachedPath = getCachedBinaryPath()
  if (cachedPath) {
    cachedCliPath = cachedPath
    return cachedPath
  }
  return null
}

export interface RunOptions {
  pattern: string
  lang: CliLanguage
  paths?: string[]
  globs?: string[]
  rewrite?: string
  context?: number
  updateAll?: boolean
}

export async function runSg(options: RunOptions): Promise<SgResult> {
  const shouldSeparateWritePass = !!(options.rewrite && options.updateAll)

  const args = ["run", "-p", options.pattern, "--lang", options.lang, "--json=compact"]

  if (options.rewrite) {
    args.push("-r", options.rewrite)
    if (options.updateAll && !shouldSeparateWritePass) {
      args.push("--update-all")
    }
  }

  if (options.context && options.context > 0) {
    args.push("-C", String(options.context))
  }

  if (options.globs) {
    for (const glob of options.globs) {
      args.push("--globs", glob)
    }
  }

  const paths = options.paths && options.paths.length > 0 ? options.paths : ["."]
  args.push(...paths)

  let cliPath = getSgCliPath()

  if (!cliPath || !existsSync(cliPath)) {
    const downloadedPath = await ensureAstGrepBinary()
    if (downloadedPath) {
      cliPath = downloadedPath
      cachedCliPath = downloadedPath
    } else {
      return {
        matches: [],
        totalMatches: 0,
        truncated: false,
        error:
          `ast-grep (sg) binary not found.\n\n` +
          `Install options:\n` +
          `  bun add -D @ast-grep/cli\n` +
          `  cargo install ast-grep --locked\n` +
          `  brew install ast-grep`,
      }
    }
  }

  const timeout = DEFAULT_TIMEOUT_MS

  const proc = spawn([cliPath, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })

  let stdout: string
  let stderr: string
  let exitCode: number

  try {
    const output = await Promise.race([
      (async () => {
        const stdout = await new Response(proc.stdout).text()
        const stderr = await new Response(proc.stderr).text()
        const exitCode = await proc.exited
        return { stdout, stderr, exitCode }
      })(),
      new Promise<never>((_, reject) => 
        setTimeout(() => reject(new Error("timeout")), timeout)
      )
    ])
    stdout = output.stdout
    stderr = output.stderr
    exitCode = output.exitCode
  } catch (error) {
    if (error instanceof Error && error.message.includes("timeout")) {
      return {
        matches: [],
        totalMatches: 0,
        truncated: true,
        truncatedReason: "timeout",
        error: error.message,
      }
    }

    const errorMessage = error instanceof Error ? error.message : String(error)
    const isNoEntry =
      errorMessage.includes("ENOENT") || errorMessage.includes("not found")

    if (isNoEntry) {
      const downloadedPath = await ensureAstGrepBinary()
      if (downloadedPath) {
        cachedCliPath = downloadedPath
        return runSg(options)
      } else {
        return {
          matches: [],
          totalMatches: 0,
          truncated: false,
          error:
            `ast-grep CLI binary not found.\n\n` +
            `Auto-download failed. Manual install options:\n` +
            `  bun add -D @ast-grep/cli\n` +
            `  cargo install ast-grep --locked\n` +
            `  brew install ast-grep`,
        }
      }
    }

    return {
      matches: [],
      totalMatches: 0,
      truncated: false,
      error: `Failed to spawn ast-grep: ${errorMessage}`,
    }
  }

  if (exitCode !== 0 && stdout.trim() === "") {
    if (stderr.includes("No files found")) {
      return { matches: [], totalMatches: 0, truncated: false }
    }
    if (stderr.trim()) {
      return { matches: [], totalMatches: 0, truncated: false, error: stderr.trim() }
    }
    return { matches: [], totalMatches: 0, truncated: false }
  }

  const jsonResult = createSgResultFromStdout(stdout)

  if (shouldSeparateWritePass && jsonResult.matches.length > 0) {
    const writeArgs = args.filter(a => a !== "--json=compact")
    writeArgs.push("--update-all")

    const writeProc = spawn([cliPath, ...writeArgs], {
      stdout: "pipe",
      stderr: "pipe",
    })

    try {
      const writeStdout = await new Response(writeProc.stdout).text()
      const writeStderr = await new Response(writeProc.stderr).text()
      const writeExitCode = await writeProc.exited
      if (writeExitCode !== 0) {
        const errorDetail = writeStderr.trim() || `ast-grep exited with code ${writeExitCode}`
        return { ...jsonResult, error: `Replace failed: ${errorDetail}` }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return { ...jsonResult, error: `Replace failed: ${errorMessage}` }
    }
  }

  return jsonResult
}
