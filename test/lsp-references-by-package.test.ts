import { afterEach, beforeAll, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { delimiter, dirname, join } from "path"

import { lsp_find_references } from "../src/lsp/find-references-tool"
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
  const dir = mkdtempSync(join(tmpdir(), "lsp-refs-pkg-"))
  tempDirs.push(dir)
  return dir
}

function writeProjectFile(root: string, relativePath: string, content: string): string {
  const filePath = join(root, relativePath)
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, content, "utf-8")
  return filePath
}

function writeFixturePackage(root: string, packageName: string, dtsBody: string): void {
  const pkgDir = join(root, "node_modules", ...packageName.split("/"))
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: packageName, version: "1.0.0", types: "index.d.ts" }, null, 2),
    "utf-8",
  )
  writeFileSync(join(pkgDir, "index.d.ts"), dtsBody, "utf-8")
}

function createBaseProject(): string {
  const root = createTempDir()
  writeProjectFile(
    root,
    "package.json",
    JSON.stringify({ name: "lsp-refs-pkg-test", private: true }, null, 2),
  )
  writeProjectFile(
    root,
    "tsconfig.json",
    JSON.stringify(
      { compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "bundler" } },
      null,
      2,
    ),
  )
  return root
}

function asText(output: unknown): string {
  if (typeof output === "string") return output
  if (output && typeof output === "object" && "output" in output) {
    return String((output as { output: string }).output)
  }
  return String(output)
}

describe("lsp_find_references by packageName", () => {
  it("emits a header block per package when symbol is located", async () => {
    const root = createBaseProject()
    writeFixturePackage(root, "@fixture/refs", `export class Widget {}\n`)

    const output = asText(
      await lsp_find_references.execute(
        {
          packageName: "@fixture/refs",
          symbolName: "Widget",
          workspaceRoot: root,
        },
        {} as never,
      ),
    )

    expect(output).toContain("=== @fixture/refs :: Widget ===")
  }, 30000)

  it("returns friendly message when symbol is missing", async () => {
    const root = createBaseProject()
    writeFixturePackage(root, "@fixture/refs", `export class Other {}\n`)

    const output = asText(
      await lsp_find_references.execute(
        {
          packageName: "@fixture/refs",
          symbolName: "NotThere",
          workspaceRoot: root,
        },
        {} as never,
      ),
    )

    expect(output).toContain("not found in package(s) matching")
  })

  it("errors when symbolName is missing", async () => {
    const root = createBaseProject()
    writeFixturePackage(root, "@fixture/refs", `export class X {}\n`)

    const output = asText(
      await lsp_find_references.execute(
        { packageName: "@fixture/refs", workspaceRoot: root },
        {} as never,
      ),
    )

    expect(output).toContain("Error")
    expect(output).toContain("symbolName is required")
  })

  it("keeps backward compatibility with filePath + line + character", async () => {
    const root = createBaseProject()
    const defsPath = writeProjectFile(
      root,
      "src/defs.ts",
      ["export function greet(name: string): string {", "  return name", "}", ""].join("\n"),
    )
    const indexPath = writeProjectFile(
      root,
      "src/index.ts",
      ['import { greet } from "./defs"', "", 'greet("x")', ""].join("\n"),
    )

    const output = asText(
      await lsp_find_references.execute(
        { filePath: indexPath, line: 3, character: 1, includeDeclaration: true },
        {} as never,
      ),
    )

    expect(output).toContain(defsPath)
    expect(output).toContain(indexPath)
  }, 20000)
})
