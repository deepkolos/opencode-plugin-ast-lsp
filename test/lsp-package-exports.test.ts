import { afterEach, beforeAll, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { delimiter, dirname, join } from "path"

import { lsp_package_exports } from "../src/lsp/package-exports-tool"
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
  const dir = mkdtempSync(join(tmpdir(), "lsp-pkg-exp-"))
  tempDirs.push(dir)
  return dir
}

function writeProjectFile(root: string, relativePath: string, content: string): string {
  const filePath = join(root, relativePath)
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, content, "utf-8")
  return filePath
}

function writeFixturePackage(
  root: string,
  packageName: string,
  files: Record<string, string>,
  pkgJson: Record<string, unknown> = { types: "index.d.ts" },
): void {
  const pkgDir = join(root, "node_modules", ...packageName.split("/"))
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: packageName, version: "1.0.0", ...pkgJson }, null, 2),
    "utf-8",
  )
  for (const [rel, content] of Object.entries(files)) {
    writeProjectFile(pkgDir, rel, content)
  }
}

function createBaseProject(): string {
  const root = createTempDir()
  writeProjectFile(
    root,
    "package.json",
    JSON.stringify({ name: "pkg-exp-test", private: true }, null, 2),
  )
  return root
}

describe("lsp_package_exports", () => {
  it("lists all top-level exported declarations", async () => {
    const root = createBaseProject()
    writeFixturePackage(root, "@fixture/core", {
      "index.d.ts":
        `export class Texture2D {}\n` +
        `export interface Options { name: string }\n` +
        `export type RGBA = [number, number, number, number];\n` +
        `export enum Wrap { Clamp, Repeat }\n` +
        `export function createTexture(): Texture2D { return null as any }\n` +
        `export const VERSION: string = "1.0.0";\n`,
    })

    const result = (await lsp_package_exports.execute(
      {
        packageName: "@fixture/core",
        workspaceRoot: root,
        strategy: "dts-scan",
      },
      {} as never,
    )) as string

    expect(result).toContain("Texture2D (Class)")
    expect(result).toContain("Options (Interface)")
    expect(result).toContain("RGBA (TypeAlias)")
    expect(result).toContain("Wrap (Enum)")
    expect(result).toContain("createTexture (Function)")
    expect(result).toContain("VERSION (Variable)")
  })

  it("filters by kind", async () => {
    const root = createBaseProject()
    writeFixturePackage(root, "@fixture/mix", {
      "index.d.ts":
        `export class A {}\n` +
        `export interface B {}\n` +
        `export function c(): void {}\n`,
    })

    const result = (await lsp_package_exports.execute(
      {
        packageName: "@fixture/mix",
        workspaceRoot: root,
        strategy: "dts-scan",
        kinds: ["interface"],
      },
      {} as never,
    )) as string

    expect(result).toContain("B (Interface)")
    expect(result).not.toContain("A (Class)")
    expect(result).not.toContain("c (Function)")
  })

  it("filters by case-insensitive query substring", async () => {
    const root = createBaseProject()
    writeFixturePackage(root, "@fixture/q", {
      "index.d.ts":
        `export class TextureA {}\n` +
        `export class TextureB {}\n` +
        `export class OtherThing {}\n`,
    })

    const result = (await lsp_package_exports.execute(
      {
        packageName: "@fixture/q",
        workspaceRoot: root,
        strategy: "dts-scan",
        query: "texture",
      },
      {} as never,
    )) as string

    expect(result).toContain("TextureA")
    expect(result).toContain("TextureB")
    expect(result).not.toContain("OtherThing")
  })

  it("resolves re-exports from relative entries", async () => {
    const root = createBaseProject()
    writeFixturePackage(root, "@fixture/reexport", {
      "index.d.ts": `export { Inner } from "./inner";\nexport class Outer {}\n`,
      "inner.d.ts": `export class Inner {}\n`,
    })

    const result = (await lsp_package_exports.execute(
      {
        packageName: "@fixture/reexport",
        workspaceRoot: root,
        strategy: "dts-scan",
      },
      {} as never,
    )) as string

    expect(result).toContain("Outer (Class)")
    expect(result).toContain("Inner")
  })

  it("supports glob matching across multiple packages with grouping", async () => {
    const root = createBaseProject()
    writeFixturePackage(root, "@fixture/a", {
      "index.d.ts": `export class Alpha {}\n`,
    })
    writeFixturePackage(root, "@fixture/b", {
      "index.d.ts": `export interface Beta {}\n`,
    })
    writeFixturePackage(root, "@other/c", {
      "index.d.ts": `export class Gamma {}\n`,
    })

    const result = (await lsp_package_exports.execute(
      {
        packageName: "@fixture/*",
        workspaceRoot: root,
        strategy: "dts-scan",
        groupByPackage: true,
      },
      {} as never,
    )) as string

    expect(result).toContain("=== @fixture/a")
    expect(result).toContain("=== @fixture/b")
    expect(result).toContain("Alpha (Class)")
    expect(result).toContain("Beta (Interface)")
    expect(result).not.toContain("Gamma")
  })

  it("flat output uses [pkg] prefix when groupByPackage=false", async () => {
    const root = createBaseProject()
    writeFixturePackage(root, "@flat/a", {
      "index.d.ts": `export class Alpha {}\n`,
    })
    writeFixturePackage(root, "@flat/b", {
      "index.d.ts": `export class Beta {}\n`,
    })

    const result = (await lsp_package_exports.execute(
      {
        packageName: "@flat/*",
        workspaceRoot: root,
        strategy: "dts-scan",
        groupByPackage: false,
      },
      {} as never,
    )) as string

    expect(result).toContain("[@flat/a] Alpha")
    expect(result).toContain("[@flat/b] Beta")
  })

  it("truncates to limit and reports it", async () => {
    const root = createBaseProject()
    const lines = Array.from({ length: 10 }, (_, i) => `export class Sym${i} {}`).join("\n")
    writeFixturePackage(root, "@fixture/many", { "index.d.ts": lines + "\n" })

    const result = (await lsp_package_exports.execute(
      {
        packageName: "@fixture/many",
        workspaceRoot: root,
        strategy: "dts-scan",
        limit: 3,
      },
      {} as never,
    )) as string

    expect(result).toMatch(/showing 3/)
  })
})
