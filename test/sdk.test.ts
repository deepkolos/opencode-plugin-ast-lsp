import { afterEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { discoverPackages } from "../src/sdk"
import { lsp_discover } from "../src/lsp/discover-tool"

const directories: string[] = []
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "ast-lsp-sdk-"))
  directories.push(root)
  for (const name of ["textures", "audio"]) {
    const directory = join(root, "node_modules", "@fixture", name)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, "package.json"), JSON.stringify({ name: `@fixture/${name}`, types: "index.d.ts" }))
    writeFileSync(join(directory, "index.d.ts"), 'export * from "./types";\n')
    writeFileSync(join(directory, "types.d.ts"), name === "textures"
      ? "/** A texture. */\nexport declare class Texture {}\nexport interface TextureOptions { width: number }\n"
      : "export declare function play(): void;\n")
  }
  return root
}

describe("package discovery SDK", () => {
  it("discovers multiple packages and re-exported declarations with source locations and docs", () => {
    const result = discoverPackages({ packageName: ["@fixture/textures", "@fixture/audio"], workspaceRoot: fixture() })
    expect(result.total).toBe(3)
    expect(result.warnings).toEqual([])
    const texture = result.packages.find(pkg => pkg.packageName === "@fixture/textures")!.symbols.find(symbol => symbol.name === "Texture")!
    expect(texture.kind).toBe("Class")
    expect(texture.location.filePath).toBe("@fixture/textures/types.d.ts")
    expect(texture.location.line).toBe(2)
    expect(texture.documentation).toBe("A texture.")
  })

  it("keeps tool and SDK package results identical, including filters and truncation", async () => {
    const options = { packageName: "@fixture/*", workspaceRoot: fixture(), query: "Texture", limit: 1 }
    const sdk = discoverPackages(options)
    const tool = JSON.parse(String(await lsp_discover.execute(options, {} as never)))
    expect(tool.ok).toBe(true)
    expect(tool.data.packages).toEqual(sdk.packages)
    expect(tool.data.total).toBe(2)
    expect(tool.data.shown).toBe(1)
    expect(tool.truncated).toBe(true)
    expect(sdk.truncated).toBe(true)
  })

  it("rejects invalid limits before scanning", () => {
    expect(() => discoverPackages({ packageName: "@fixture/textures", workspaceRoot: fixture(), limit: 0 })).toThrow("limit must")
  })
})
