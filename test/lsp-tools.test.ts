import { afterEach, beforeAll, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { delimiter, dirname, join } from "path"

import { lsp_diagnostics } from "../src/lsp/diagnostics-tool"
import { lsp_find_references } from "../src/lsp/find-references-tool"
import { lsp_goto_definition } from "../src/lsp/goto-definition-tool"
import { lsp_hover } from "../src/lsp/hover-tool"
import { lsp_prepare_rename, lsp_rename } from "../src/lsp/rename-tools"
import { lsp_symbols } from "../src/lsp/symbols-tool"
import { lspManager } from "../src/lsp/lsp-server"

const tempDirs: string[] = []

beforeAll(() => {
  const localBin = join(process.cwd(), "node_modules", ".bin")
  process.env.PATH = `${localBin}${delimiter}${process.env.PATH ?? ""}`
})

afterEach(async () => {
  await lspManager.stopAll()
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "standalone-lsp-tools-"))
  tempDirs.push(dir)
  return dir
}

function writeProjectFile(root: string, relativePath: string, content: string): string {
  const filePath = join(root, relativePath)
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, content, "utf-8")
  return filePath
}

function createTsProject() {
  const root = createTempDir()
  writeProjectFile(
    root,
    "package.json",
    JSON.stringify({ name: "lsp-test-project", private: true, type: "module" }, null, 2),
  )
  writeProjectFile(
    root,
    "tsconfig.json",
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "bundler",
          strict: true,
          noEmit: true,
        },
        include: ["src/**/*"],
      },
      null,
      2,
    ),
  )

  const defsPath = writeProjectFile(
    root,
    "src/defs.ts",
    [
      "/**",
      " * Greets a person",
      " * @param name The name of the person",
      " */",
      "export function greet(name: string): string {",
      "  return `hi ${name}`",
      "}",
      "",
    ].join("\n"),
  )
  const indexPath = writeProjectFile(
    root,
    "src/index.ts",
    [
      'import { greet } from "./defs"',
      "",
      "export function entry(): string {",
      '  return greet("world")',
      "}",
      "",
    ].join("\n"),
  )
  const brokenPath = writeProjectFile(
    root,
    "src/broken.ts",
    [
      "export const broken: string = 123",
      "",
    ].join("\n"),
  )

  return { root, srcDir: join(root, "src"), defsPath, indexPath, brokenPath }
}

function findPosition(source: string, search: string): { line: number; character: number } {
  const index = source.indexOf(search)
  if (index === -1) {
    throw new Error(`Search text not found: ${search}`)
  }

  const before = source.slice(0, index)
  const lines = before.split("\n")
  return {
    line: lines.length,
    character: lines[lines.length - 1]?.length ?? 0,
  }
}

function asText(output: string | { output: string }): string {
  return typeof output === "string" ? output : output.output
}

describe("lsp tools", () => {
  it("uses real lsp_goto_definition on a TypeScript workspace", async () => {
    const { defsPath, indexPath } = createTsProject()
    const source = readFileSync(indexPath, "utf-8")
    const position = findPosition(source, 'greet("world")')

    const output = asText(
      await lsp_goto_definition.execute(
        { filePath: indexPath, line: position.line, character: position.character },
        {} as never,
      ),
    )

    expect(output).toContain(defsPath)
  })

  it("uses real lsp_find_references across files", async () => {
    const { defsPath, indexPath } = createTsProject()
    const source = readFileSync(indexPath, "utf-8")
    const position = findPosition(source, 'greet("world")')

    const output = asText(
      await lsp_find_references.execute(
        { filePath: indexPath, line: position.line, character: position.character, includeDeclaration: true },
        {} as never,
      ),
    )

    expect(output).toContain(defsPath)
    expect(output).toContain(indexPath)
  })

  it("uses real lsp_symbols for document symbols", async () => {
    const { indexPath } = createTsProject()

    const output = asText(
      await lsp_symbols.execute(
        { filePath: indexPath, scope: "document" },
        {} as never,
      ),
    )

    expect(output).toContain("entry (Function)")
  })

  it("uses real lsp_hover to get documentation", async () => {
    const { indexPath } = createTsProject()
    const source = readFileSync(indexPath, "utf-8")
    const position = findPosition(source, 'greet("world")')

    const output = asText(
      await lsp_hover.execute(
        { filePath: indexPath, line: position.line, character: position.character },
        {} as never,
      ),
    )

    expect(output).toContain("greet(name: string): string")
    expect(output).toContain("Greets a person")
  })

  it("uses real lsp_diagnostics for directory diagnostics", async () => {
    const { srcDir, brokenPath } = createTsProject()

    const output = asText(
      await lsp_diagnostics.execute(
        { filePath: srcDir, severity: "error" },
        {} as never,
      ),
    )

    expect(output).toContain(`Directory: ${srcDir}`)
    expect(output).toContain(brokenPath)
    expect(output).toContain("not assignable to type 'string'")
  }, 10000)

  it("uses real lsp_prepare_rename on a renameable symbol", async () => {
    const { indexPath } = createTsProject()
    const source = readFileSync(indexPath, "utf-8")
    const position = findPosition(source, 'greet("world")')

    const output = asText(
      await lsp_prepare_rename.execute(
        { filePath: indexPath, line: position.line, character: position.character },
        {} as never,
      ),
    )

    expect(output).toContain("Rename available at")
  })

  it("uses real lsp_rename and applies workspace edits", async () => {
    const { defsPath, indexPath } = createTsProject()
    const source = readFileSync(defsPath, "utf-8")
    const position = findPosition(source, "greet(name")

    const output = asText(
      await lsp_rename.execute(
        { filePath: defsPath, line: position.line, character: position.character, newName: "renamedGreet" },
        {} as never,
      ),
    )

    expect(output).toContain("Applied")
    expect(output).toContain(defsPath)
    expect(output).toContain(indexPath)
    expect(readFileSync(defsPath, "utf-8")).toContain("function renamedGreet")
    expect(readFileSync(indexPath, "utf-8")).toContain('import { renamedGreet } from "./defs"')
    expect(readFileSync(indexPath, "utf-8")).toContain('return renamedGreet("world")')
  })
})
