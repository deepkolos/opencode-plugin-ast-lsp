import { afterEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { dirname, join } from "path"

import { inferExtensionFromDirectory } from "../src/lsp/infer-extension"

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "opencode-plugin-ast-lsp-"))
  tempDirs.push(dir)
  return dir
}

function writeProjectFile(root: string, relativePath: string, content = ""): void {
  const filePath = join(root, relativePath)
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, content, "utf-8")
}

describe("inferExtensionFromDirectory", () => {
  it("returns null for an empty directory", () => {
    const dir = createTempDir()

    expect(inferExtensionFromDirectory(dir)).toBeNull()
  })

  it("returns the most common recognized extension", () => {
    const dir = createTempDir()
    writeProjectFile(dir, "src/app.ts", "export const app = 1")
    writeProjectFile(dir, "src/util.ts", "export const util = 1")
    writeProjectFile(dir, "scripts/build.js", "console.log('build')")

    expect(inferExtensionFromDirectory(dir)).toBe(".ts")
  })

  it("ignores skipped build and dependency directories", () => {
    const dir = createTempDir()
    writeProjectFile(dir, "src/main.ts", "export const main = 1")
    writeProjectFile(dir, "node_modules/pkg/index.js", "module.exports = {}")
    writeProjectFile(dir, "dist/index.js", "console.log('dist')")
    writeProjectFile(dir, "build/index.js", "console.log('build')")

    expect(inferExtensionFromDirectory(dir)).toBe(".ts")
  })
})
