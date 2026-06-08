import { afterEach, beforeAll, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { delimiter, dirname, join } from "path"

import plugin from "../src/index"
import { lsp_discover, lsp_inspect, lsp_usages } from "../src/lsp"
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
  const dir = mkdtempSync(join(tmpdir(), "lsp-high-level-"))
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
    JSON.stringify({ name: "lsp-high-level-test", private: true, type: "module" }, null, 2),
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
        include: ["src/**/*", ".trae-probe/**/*"],
      },
      null,
      2,
    ),
  )
  return root
}

function findPosition(source: string, search: string): { line: number; character: number } {
  const index = source.indexOf(search)
  if (index === -1) throw new Error(`Search text not found: ${search}`)
  const before = source.slice(0, index)
  const lines = before.split("\n")
  return {
    line: lines.length,
    character: lines[lines.length - 1]?.length ?? 0,
  }
}

function asText(output: unknown): string {
  return typeof output === "string" ? output : String(output)
}

function asJson(output: unknown): any {
  return JSON.parse(asText(output))
}

describe("high-level LSP tools", () => {
  it("registers only high-level LSP tools in the plugin surface", async () => {
    const root = createBaseProject()
    const result = await plugin({ directory: root } as never)
    const toolNames = Object.keys(result.tool ?? {})

    expect(toolNames).toContain("lsp_inspect")
    expect(toolNames).toContain("lsp_discover")
    expect(toolNames).toContain("lsp_usages")
    expect(toolNames).toContain("lsp_diagnostics")
    expect(toolNames).toContain("lsp_rename")
    expect(toolNames).not.toContain("lsp_hover")
    expect(toolNames).not.toContain("lsp_goto_definition")
    expect(toolNames).not.toContain("lsp_find_references")
    expect(toolNames).not.toContain("lsp_symbols")
    expect(toolNames).not.toContain("lsp_package_symbol")
    expect(toolNames).not.toContain("lsp_package_exports")
    expect(toolNames).not.toContain("lsp_prepare_rename")
  })

  it("uses lsp_inspect to return package symbol surface and related types", async () => {
    const root = createBaseProject()
    writeFixturePackage(
      root,
      "@fixture/context",
      [
        "/** Texture instance. */",
        "export interface Texture2D {",
        "  /** Width in pixels. */",
        "  width: number",
        "}",
        "/** Texture creation options. */",
        "export interface TextureOptions {",
        "  /** Texture label. */",
        "  label: string",
        "  size: TextureSize",
        "}",
        "export interface TextureSize {",
        "  width: number",
        "  height: number",
        "}",
        "/** Creates a texture. */",
        "export function createTexture(options: TextureOptions): Texture2D",
        "",
      ].join("\n"),
    )

    const output = asJson(
      await lsp_inspect.execute(
        {
          packageName: "@fixture/context",
          symbolName: "createTexture",
          workspaceRoot: root,
          mode: "deep",
          maxDepth: 2,
        },
        {} as never,
      ),
    )

    expect(output.ok).toBe(true)
    expect(output.tool).toBe("lsp_inspect")
    const symbol = output.data.symbols[0]
    expect(symbol.symbolName).toBe("createTexture")
    expect(symbol.source.filePath).toContain(join(root, "node_modules", "@fixture", "context", "index.d.ts"))
    expect(symbol.displaySource).toContain("@fixture/context/index.d.ts")
    expect(symbol.hoverText).toContain("createTexture")
    const relatedNames = symbol.typeContext.relatedTypes.map((item: { name: string }) => item.name)
    expect(relatedNames).toContain("TextureOptions")
    expect(relatedNames).toContain("TextureSize")
    expect(relatedNames).toContain("Texture2D")
    expect(JSON.stringify(output)).toContain("Texture creation options.")
  }, 20000)

  it("uses lsp_discover to list package APIs without exposing raw export tooling", async () => {
    const root = createBaseProject()
    writeFixturePackage(
      root,
      "@fixture/discover",
      [
        "export class TextureLoader {}",
        "export interface TextureOptions { label: string }",
        "export function createTexture(options: TextureOptions): void",
        "export function createBuffer(): void",
        "",
      ].join("\n"),
    )

    const output = asJson(
      await lsp_discover.execute(
        {
          packageName: "@fixture/discover",
          workspaceRoot: root,
          query: "Texture",
        },
        {} as never,
      ),
    )

    expect(output.ok).toBe(true)
    expect(output.tool).toBe("lsp_discover")
    expect(output.data.packages[0].packageName).toBe("@fixture/discover")
    const names = output.data.packages[0].symbols.map((item: { name: string }) => item.name)
    expect(names).toContain("TextureLoader")
    expect(names).toContain("TextureOptions")
    expect(names).toContain("createTexture")
    expect(names).not.toContain("createBuffer")
    expect(output.hints.join("\n")).toContain("lsp_inspect")
  })

  it("uses lsp_discover to flatten nested file symbols for agent selection", async () => {
    const root = createBaseProject()
    const filePath = writeProjectFile(
      root,
      "src/controller.ts",
      [
        "export class TextureController {",
        "  load(path: string): void {}",
        "  get size(): number { return 1 }",
        "}",
        "",
      ].join("\n"),
    )

    const output = asJson(
      await lsp_discover.execute(
        { filePath },
        {} as never,
      ),
    )

    expect(output.ok).toBe(true)
    const symbolPaths = output.data.fileSymbols.map((item: { symbolPath: string[] }) => item.symbolPath.join("."))
    expect(symbolPaths).toContain("TextureController")
    expect(symbolPaths).toContain("TextureController.load")
    expect(symbolPaths).toContain("TextureController.size")
  }, 20000)

  it("uses lsp_usages to return references with source snippets", async () => {
    const root = createBaseProject()
    const defsPath = writeProjectFile(
      root,
      "src/defs.ts",
      [
        "export function makeTexture(label: string): string {",
        "  return label",
        "}",
        "",
      ].join("\n"),
    )
    const indexPath = writeProjectFile(
      root,
      "src/index.ts",
      [
        'import { makeTexture } from "./defs"',
        "",
        "export const first = makeTexture('a')",
        "export const second = makeTexture('b')",
        "",
      ].join("\n"),
    )
    const source = readFileSync(defsPath, "utf-8")
    const position = findPosition(source, "makeTexture")

    const output = asJson(
      await lsp_usages.execute(
        {
          filePath: defsPath,
          line: position.line,
          character: position.character,
          contextLines: 1,
        },
        {} as never,
      ),
    )

    expect(output.ok).toBe(true)
    expect(output.tool).toBe("lsp_usages")
    expect(output.data.total).toBeGreaterThanOrEqual(3)
    expect(JSON.stringify(output.data.groups)).toContain(defsPath)
    expect(JSON.stringify(output.data.groups)).toContain(indexPath)
    expect(JSON.stringify(output.data.groups)).toContain("makeTexture('a')")
    expect(JSON.stringify(output.data.groups)).toContain("makeTexture('b')")
  }, 20000)
})
