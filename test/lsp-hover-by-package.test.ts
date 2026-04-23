import { afterEach, beforeAll, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { delimiter, dirname, join } from "path"

import { lsp_hover } from "../src/lsp/hover-tool"
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
  const dir = mkdtempSync(join(tmpdir(), "lsp-hover-pkg-"))
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
    JSON.stringify({ name: "lsp-hover-pkg-test", private: true }, null, 2),
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

describe("lsp_hover by packageName", () => {
  it("returns a by-package block for an exact package name match", async () => {
    const root = createBaseProject()
    writeFixturePackage(
      root,
      "@fixture/hover",
      `export class Texture2D {\n  width: number;\n  height: number;\n}\n`,
    )

    const output = asText(
      await lsp_hover.execute(
        {
          packageName: "@fixture/hover",
          symbolName: "Texture2D",
          workspaceRoot: root,
        },
        {} as never,
      ),
    )

    expect(output).toContain("@fixture/hover :: Texture2D")
    expect(output).toContain("File:")
    expect(output).toContain("index.d.ts")
  }, 20000)

  it("returns friendly message when symbol is missing", async () => {
    const root = createBaseProject()
    writeFixturePackage(root, "@fixture/hover", `export class Other {}\n`)

    const output = asText(
      await lsp_hover.execute(
        {
          packageName: "@fixture/hover",
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
    writeFixturePackage(root, "@fixture/hover", `export class X {}\n`)

    const output = asText(
      await lsp_hover.execute(
        { packageName: "@fixture/hover", workspaceRoot: root },
        {} as never,
      ),
    )

    expect(output).toContain("Error")
    expect(output).toContain("symbolName is required")
  })

  it("handles glob pattern across multiple packages", async () => {
    const root = createBaseProject()
    writeFixturePackage(root, "@multi/a", `export class Shared {}\n`)
    writeFixturePackage(root, "@multi/b", `export class Shared {}\n`)

    const output = asText(
      await lsp_hover.execute(
        {
          packageName: "@multi/*",
          symbolName: "Shared",
          workspaceRoot: root,
        },
        {} as never,
      ),
    )

    expect(output).toContain("@multi/a :: Shared")
    expect(output).toContain("@multi/b :: Shared")
  }, 30000)

  it("keeps backward compatibility with filePath + line + character", async () => {
    const root = createBaseProject()
    writeProjectFile(
      root,
      "tsconfig.json",
      JSON.stringify(
        { compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "bundler" } },
        null,
        2,
      ),
    )
    const indexPath = writeProjectFile(
      root,
      "src/index.ts",
      [
        "/**",
        " * Greets",
        " */",
        "export function greet(name: string): string {",
        '  return `hi ${name}`',
        "}",
        "",
        "greet('x')",
        "",
      ].join("\n"),
    )

    const output = asText(
      await lsp_hover.execute(
        { filePath: indexPath, line: 8, character: 1 },
        {} as never,
      ),
    )

    expect(output).toContain("greet")
  }, 20000)
})
