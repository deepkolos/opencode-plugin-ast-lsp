import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs"
import * as path from "node:path"

export function getCachedBinaryPath(cacheDir: string, binaryName: string): string | null {
  const binaryPath = path.join(cacheDir, binaryName)
  return existsSync(binaryPath) ? binaryPath : null
}

export function ensureCacheDir(cacheDir: string): void {
  if (!existsSync(cacheDir)) {
    mkdirSync(cacheDir, { recursive: true })
  }
}

export async function downloadArchive(downloadUrl: string, archivePath: string): Promise<void> {
  const response = await fetch(downloadUrl, { redirect: "follow" })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`)
  }

  const arrayBuffer = await response.arrayBuffer()
  await Bun.write(archivePath, arrayBuffer)
}

export async function extractZipArchive(archivePath: string, destDir: string): Promise<void> {
  const proc = Bun.spawn(["unzip", "-o", archivePath, "-d", destDir], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text()
    throw new Error(`unzip failed (exit ${exitCode}): ${stderr}`)
  }
}

export function cleanupArchive(archivePath: string): void {
  if (existsSync(archivePath)) {
    unlinkSync(archivePath)
  }
}

export function ensureExecutable(binaryPath: string): void {
  if (process.platform !== "win32" && existsSync(binaryPath)) {
    chmodSync(binaryPath, 0o755)
  }
}
