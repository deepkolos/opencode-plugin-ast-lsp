import { afterEach, beforeAll, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { delimiter, dirname, join } from "path"

import { lsp_goto_definition } from "../src/lsp/goto-definition-tool"
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
  const dir = mkdtempSync(join(tmpdir(), "lsp-goto-pkg-"))
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
    JSON.stringify({ name: "lsp-goto-pkg-test", private: true }, null, 2),
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

describe("lsp_goto_definition by packageName", () => {
  it("returns declaration location for exact package name match", async () => {
    const root = createBaseProject()
    writeFixturePackage(
      root,
      "@fixture/goto",
      `export class Texture2D {}\n`,
    )

    const output = asText(
      await lsp_goto_definition.execute(
        {
          packageName: "@fixture/goto",
          symbolName: "Texture2D",
          workspaceRoot: root,
        },
        {} as never,
      ),
    )

    expect(output).toContain("@fixture/goto :: Texture2D")
    expect(output).toContain("index.d.ts")
  }, 20000)

  it("returns friendly message when symbol is missing", async () => {
    const root = createBaseProject()
    writeFixturePackage(root, "@fixture/goto", `export class Other {}\n`)

    const output = asText(
      await lsp_goto_definition.execute(
        {
          packageName: "@fixture/goto",
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
    writeFixturePackage(root, "@fixture/goto", `export class X {}\n`)

    const output = asText(
      await lsp_goto_definition.execute(
        { packageName: "@fixture/goto", workspaceRoot: root },
        {} as never,
      ),
    )

    expect(output).toContain("Error")
    expect(output).toContain("symbolName is required")
  })

  it("supports glob pattern across multiple packages", async () => {
    const root = createBaseProject()
    writeFixturePackage(root, "@goto-multi/a", `export class Vec3 {}\n`)
    writeFixturePackage(root, "@goto-multi/b", `export class Vec3 {}\n`)

    const output = asText(
      await lsp_goto_definition.execute(
        {
          packageName: "@goto-multi/*",
          symbolName: "Vec3",
          workspaceRoot: root,
        },
        {} as never,
      ),
    )

    expect(output).toContain("@goto-multi/a :: Vec3")
    expect(output).toContain("@goto-multi/b :: Vec3")
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
      await lsp_goto_definition.execute(
        { filePath: indexPath, line: 3, character: 1 },
        {} as never,
      ),
    )

    expect(output).toContain(defsPath)
  }, 20000)
})
