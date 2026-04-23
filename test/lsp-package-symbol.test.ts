import { afterEach, beforeAll, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { delimiter, dirname, join } from "path"

import { lsp_package_symbol } from "../src/lsp/package-symbol-tool"
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
  const dir = mkdtempSync(join(tmpdir(), "lsp-pkg-sym-"))
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
  dtsBody: string,
): void {
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
    JSON.stringify({ name: "pkg-sym-test", private: true }, null, 2),
  )
  return root
}

describe("lsp_package_symbol", () => {
  it("finds a class declaration in a fixture package via dts-scan", async () => {
    const root = createBaseProject()
    writeFixturePackage(
      root,
      "@fixture/core",
      `export class Texture2D {\n  width: number;\n  height: number;\n}\n\nexport interface Options {\n  name: string;\n}\n`,
    )

    const result = (await lsp_package_symbol.execute(
      {
        packageName: "@fixture/core",
        symbolName: "Texture2D",
        workspaceRoot: root,
        strategy: "dts-scan",
        includeHover: false,
      },
      {} as never,
    )) as string

    expect(result).toContain("@fixture/core :: Texture2D")
    expect(result).toContain("Kind: Class")
    expect(result).toContain("index.d.ts")
  })

  it("returns error text when symbol is missing", async () => {
    const root = createBaseProject()
    writeFixturePackage(root, "@fixture/core", `export class Bar {}\n`)

    const result = (await lsp_package_symbol.execute(
      {
        packageName: "@fixture/core",
        symbolName: "NonExistent",
        workspaceRoot: root,
        strategy: "dts-scan",
        includeHover: false,
      },
      {} as never,
    )) as string

    expect(result).toContain("not found")
  })

  it("supports glob scope pattern across multiple packages", async () => {
    const root = createBaseProject()
    writeFixturePackage(root, "@fixture/a", `export class Shared {}\n`)
    writeFixturePackage(root, "@fixture/b", `export class Shared {}\n`)
    writeFixturePackage(root, "@other/c", `export class Shared {}\n`)

    const result = (await lsp_package_symbol.execute(
      {
        packageName: "@fixture/*",
        symbolName: "Shared",
        workspaceRoot: root,
        strategy: "dts-scan",
        includeHover: false,
      },
      {} as never,
    )) as string

    expect(result).toContain("@fixture/a :: Shared")
    expect(result).toContain("@fixture/b :: Shared")
    expect(result).not.toContain("@other/c")
  })

  it("supports regex literal", async () => {
    const root = createBaseProject()
    writeFixturePackage(root, "@regex/a", `export interface Vec3 { x: number; y: number; z: number }\n`)
    writeFixturePackage(root, "@regex/b", `export class Vec3 {}\n`)

    const result = (await lsp_package_symbol.execute(
      {
        packageName: "/^@regex\\//",
        symbolName: "Vec3",
        workspaceRoot: root,
        strategy: "dts-scan",
        includeHover: false,
      },
      {} as never,
    )) as string

    expect(result).toContain("@regex/a :: Vec3")
    expect(result).toContain("@regex/b :: Vec3")
  })

  it("rejects when maxPackages is exceeded", async () => {
    const root = createBaseProject()
    writeFixturePackage(root, "@big/a", `export class X {}\n`)
    writeFixturePackage(root, "@big/b", `export class X {}\n`)
    writeFixturePackage(root, "@big/c", `export class X {}\n`)

    const result = (await lsp_package_symbol.execute(
      {
        packageName: "@big/*",
        symbolName: "X",
        workspaceRoot: root,
        strategy: "dts-scan",
        includeHover: false,
        maxPackages: 1,
      },
      {} as never,
    )) as string

    expect(result).toContain("Error")
    expect(result).toContain("Too many packages matched")
  })

  it("accepts an array of package names (union)", async () => {
    const root = createBaseProject()
    writeFixturePackage(root, "alpha", `export class Foo {}\n`)
    writeFixturePackage(root, "beta", `export class Foo {}\n`)

    const result = (await lsp_package_symbol.execute(
      {
        packageName: ["alpha", "beta"],
        symbolName: "Foo",
        workspaceRoot: root,
        strategy: "dts-scan",
        includeHover: false,
      },
      {} as never,
    )) as string

    expect(result).toContain("alpha :: Foo")
    expect(result).toContain("beta :: Foo")
  })
})
