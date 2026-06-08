import { existsSync, lstatSync, readdirSync } from "fs"
import { extname, join, resolve } from "path"

import { findServerForExtension } from "./server-resolution"
import { findWorkspaceRoot, isDirectoryPath, uriToPath } from "./lsp-client-wrapper"
import { filterDiagnosticsBySeverity, formatDiagnostic } from "./lsp-formatters"
import { LSPClient } from "./lsp-client"
import { lspManager } from "./lsp-server"
import { DEFAULT_MAX_DIAGNOSTICS, DEFAULT_MAX_DIRECTORY_FILES } from "./constants"
import type { Diagnostic } from "./types"

const SKIP_DIRECTORIES = new Set(["node_modules", ".git", "dist", "build", ".next", "out"])

type FileDiagnostic = {
  filePath: string
  diagnostic: Diagnostic
}

export interface DirectoryDiagnosticsResult {
  directory: string
  extension: string
  filesScanned: number
  filesCapped: boolean
  fileErrors: { file: string; error: string }[]
  diagnostics: FileDiagnostic[]
  total: number
  shown: number
  truncated: boolean
}

function collectFilesWithExtension(dir: string, extension: string, maxFiles: number): string[] {
  const files: string[] = []

  function walk(currentDir: string): void {
    if (files.length >= maxFiles) return

    let entries: string[]
    try {
      entries = readdirSync(currentDir)
    } catch {
      return
    }

    for (const entry of entries) {
      if (files.length >= maxFiles) return

      const fullPath = join(currentDir, entry)

      let stat: ReturnType<typeof lstatSync> | undefined
      try {
        stat = lstatSync(fullPath)
      } catch {
        continue
      }

      if (!stat || stat.isSymbolicLink()) {
        continue
      }

      if (stat.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry)) {
          walk(fullPath)
        }
      } else if (stat.isFile()) {
        if (extname(fullPath) === extension) {
          files.push(fullPath)
        }
      }
    }
  }

  walk(dir)
  return files
}

export async function aggregateDiagnosticsForDirectory(
  directory: string,
  extension: string,
  severity?: "error" | "warning" | "information" | "hint" | "all",
  maxFiles: number = DEFAULT_MAX_DIRECTORY_FILES
): Promise<string> {
  return formatDirectoryDiagnostics(
    await aggregateDiagnosticsForDirectoryStructured(directory, extension, severity, maxFiles),
  )
}

export async function aggregateDiagnosticsForDirectoryStructured(
  directory: string,
  extension: string,
  severity?: "error" | "warning" | "information" | "hint" | "all",
  maxFiles: number = DEFAULT_MAX_DIRECTORY_FILES
): Promise<DirectoryDiagnosticsResult> {
  if (!extension.startsWith(".")) {
    throw new Error(
      `Extension must start with a dot (e.g., ".ts", not "${extension}"). Use ".${extension}" instead.`
    )
  }

  const absDir = resolve(directory)
  if (!existsSync(absDir)) {
    throw new Error(`Directory does not exist: ${absDir}`)
  }

  const serverResult = findServerForExtension(extension)
  if (serverResult.status !== "found") {
    throw new Error(`No server found for ${extension}`)
  }

  const server = serverResult.server
  const allFiles = collectFilesWithExtension(absDir, extension, maxFiles + 1)
  const wasCapped = allFiles.length > maxFiles
  const filesToProcess = allFiles.slice(0, maxFiles)

  if (filesToProcess.length === 0) {
    return {
      directory: absDir,
      extension,
      filesScanned: 0,
      filesCapped: wasCapped,
      fileErrors: [],
      diagnostics: [],
      total: 0,
      shown: 0,
      truncated: false,
    }
  }

  const root = findWorkspaceRoot(absDir)

  const allDiagnostics: FileDiagnostic[] = []
  const fileErrors: { file: string; error: string }[] = []

  let client: LSPClient
  try {
    client = await lspManager.getClient(root, server)

    for (const file of filesToProcess) {
      try {
        const result = await client.diagnostics(file)
        const filtered = filterDiagnosticsBySeverity(result.items, severity)
        allDiagnostics.push(
          ...filtered.map((diagnostic) => ({
            filePath: file,
            diagnostic,
          }))
        )
      } catch (e) {
        fileErrors.push({
          file,
          error: e instanceof Error ? e.message : String(e),
        })
      }
    }
  } finally {
    lspManager.releaseClient(root, server.id)
  }

  const displayDiagnostics = allDiagnostics.slice(0, DEFAULT_MAX_DIAGNOSTICS)
  const wasDiagCapped = allDiagnostics.length > DEFAULT_MAX_DIAGNOSTICS

  return {
    directory: absDir,
    extension,
    filesScanned: filesToProcess.length,
    filesCapped: wasCapped,
    fileErrors,
    diagnostics: displayDiagnostics,
    total: allDiagnostics.length,
    shown: displayDiagnostics.length,
    truncated: wasDiagCapped,
  }
}

function formatDirectoryDiagnostics(result: DirectoryDiagnosticsResult): string {
  const lines: string[] = [
    `Directory: ${result.directory}`,
    `Extension: ${result.extension}`,
    `Files scanned: ${result.filesScanned}${result.filesCapped ? ` (capped)` : ""}`,
    `Files with errors: ${result.fileErrors.length}`,
    `Total diagnostics: ${result.total}`,
  ]

  if (result.fileErrors.length > 0) {
    lines.push("", "File processing errors:")
    for (const { file, error } of result.fileErrors) {
      lines.push(`  ${file}: ${error}`)
    }
  }

  if (result.diagnostics.length > 0) {
    lines.push("")
    for (const { filePath, diagnostic } of result.diagnostics) {
      lines.push(`${filePath}: ${formatDiagnostic(diagnostic)}`)
    }
    if (result.truncated) {
      lines.push("", `... (${result.total - result.shown} more diagnostics not shown)`)
    }
  }

  return lines.join("\n")
}
