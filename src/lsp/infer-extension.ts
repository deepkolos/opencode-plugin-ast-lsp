import { readdirSync, lstatSync } from "fs"
import { extname, join } from "path"

import { BUILTIN_SERVERS } from "./server-definitions"

const SUPPORTED_EXTENSIONS = new Set<string>()
for (const server of Object.values(BUILTIN_SERVERS)) {
  for (const ext of server.extensions) {
    SUPPORTED_EXTENSIONS.add(ext)
  }
}

const SKIP_DIRECTORIES = new Set(["node_modules", ".git", "dist", "build", ".next", "out"])
const MAX_SCAN_ENTRIES = 500

export function inferExtensionFromDirectory(directory: string): string | null {
  const extensionCounts = new Map<string, number>()
  let scanned = 0

  function walk(dir: string): void {
    if (scanned >= MAX_SCAN_ENTRIES) return

    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }

    for (const entry of entries) {
      if (scanned >= MAX_SCAN_ENTRIES) return

      const fullPath = join(dir, entry)

      let stat: ReturnType<typeof lstatSync> | undefined
      try {
        stat = lstatSync(fullPath)
      } catch {
        continue
      }

      if (stat?.isSymbolicLink()) continue
      scanned++

      if (stat?.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry)) {
          walk(fullPath)
        }
      } else if (stat?.isFile()) {
        const ext = extname(fullPath)
        if (ext && SUPPORTED_EXTENSIONS.has(ext)) {
          extensionCounts.set(ext, (extensionCounts.get(ext) ?? 0) + 1)
        }
      }
    }
  }

  walk(directory)

  if (extensionCounts.size === 0) return null

  let maxExt = ""
  let maxCount = 0
  for (const [ext, count] of extensionCounts) {
    if (count > maxCount) {
      maxCount = count
      maxExt = ext
    }
  }

  return maxExt || null
}
