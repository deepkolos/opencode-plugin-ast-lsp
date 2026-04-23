import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, rmSync } from "fs"
import { dirname, join, resolve, sep } from "path"
import { createRequire } from "module"

export type UnifiedSymbolKind =
  | "Class"
  | "Interface"
  | "TypeAlias"
  | "Enum"
  | "Function"
  | "Variable"
  | "Namespace"
  | "Default"
  | "Unknown"

export interface DtsExport {
  name: string
  kind: UnifiedSymbolKind
  filePath: string
  line: number
  character: number
  isReExport: boolean
  signature?: string
}

const GLOB_MATCH_CHARS = /[*?]/

function isRegexLiteral(input: string): boolean {
  if (input.length < 3) return false
  if (input[0] !== "/") return false
  const last = input.lastIndexOf("/")
  return last > 0
}

function parseRegexLiteral(input: string): RegExp {
  const last = input.lastIndexOf("/")
  const pattern = input.slice(1, last)
  const flags = input.slice(last + 1)
  return new RegExp(pattern, flags)
}

function escapeRegex(input: string): string {
  return input.replace(/[.+^${}()|[\]\\]/g, "\\$&")
}

function globToRegex(glob: string): RegExp {
  let out = ""
  for (const ch of glob) {
    if (ch === "*") {
      out += "[^/]*"
    } else if (ch === "?") {
      out += "[^/]"
    } else {
      out += escapeRegex(ch)
    }
  }
  return new RegExp(`^${out}$`)
}

function collectNodeModulesDirs(startDir: string): string[] {
  const dirs: string[] = []
  let dir = resolve(startDir)
  let prev = ""
  while (dir !== prev) {
    const nm = join(dir, "node_modules")
    if (existsSync(nm) && statSync(nm).isDirectory()) {
      dirs.push(nm)
    }
    prev = dir
    dir = dirname(dir)
  }
  return dirs
}

function listAllInstalledPackages(workspaceRoot: string): string[] {
  const nms = collectNodeModulesDirs(workspaceRoot)
  const found = new Set<string>()
  for (const nm of nms) {
    let entries: string[] = []
    try {
      entries = readdirSync(nm)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.startsWith(".")) continue
      const full = join(nm, entry)
      if (entry.startsWith("@")) {
        let subs: string[] = []
        try {
          subs = readdirSync(full)
        } catch {
          continue
        }
        for (const sub of subs) {
          if (sub.startsWith(".")) continue
          const pkgDir = join(full, sub)
          if (!isDir(pkgDir)) continue
          const name = readPkgName(pkgDir) ?? `${entry}/${sub}`
          found.add(name)
        }
      } else {
        if (!isDir(full)) continue
        const name = readPkgName(full) ?? entry
        found.add(name)
      }
    }
  }
  return Array.from(found)
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function readPkgName(pkgRoot: string): string | null {
  try {
    const pj = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf-8"))
    if (typeof pj.name === "string") return pj.name
  } catch {}
  return null
}

export function expandPackageNames(
  input: string | string[],
  workspaceRoot: string,
  maxPackages = 20,
): string[] {
  const inputs = Array.isArray(input) ? input : [input]
  const result = new Set<string>()

  for (const raw of inputs) {
    if (typeof raw !== "string" || raw.length === 0) continue

    if (isRegexLiteral(raw)) {
      const re = parseRegexLiteral(raw)
      for (const pkg of listAllInstalledPackages(workspaceRoot)) {
        if (re.test(pkg)) result.add(pkg)
      }
      continue
    }

    if (GLOB_MATCH_CHARS.test(raw)) {
      const re = globToRegex(raw)
      for (const pkg of listAllInstalledPackages(workspaceRoot)) {
        if (re.test(pkg)) result.add(pkg)
      }
      continue
    }

    result.add(raw)
  }

  const list = Array.from(result).sort()
  if (list.length > maxPackages) {
    throw new Error(
      `Too many packages matched (${list.length} > maxPackages=${maxPackages}). Narrow the pattern.`,
    )
  }
  return list
}

export function resolvePackageRoot(packageName: string, workspaceRoot: string): string | null {
  const nms = collectNodeModulesDirs(workspaceRoot)
  for (const nm of nms) {
    const candidate = join(nm, ...packageName.split("/"))
    if (existsSync(join(candidate, "package.json"))) {
      return candidate
    }
  }

  try {
    const req = createRequire(join(workspaceRoot, "__lsp_pkg_probe__.js"))
    const pkgJson = req.resolve(`${packageName}/package.json`)
    return dirname(pkgJson)
  } catch {}

  return null
}

export function getPackageDtsEntries(packageRoot: string): string[] {
  const entries: string[] = []
  let pj: Record<string, unknown> = {}
  try {
    pj = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf-8"))
  } catch {
    return entries
  }

  const pushIfDts = (p: unknown) => {
    if (typeof p !== "string") return
    const abs = resolve(packageRoot, p)
    if (!abs.endsWith(".d.ts")) return
    if (!existsSync(abs)) return
    if (!entries.includes(abs)) entries.push(abs)
  }

  pushIfDts(pj.types as unknown)
  pushIfDts(pj.typings as unknown)

  const exportsField = pj.exports as unknown
  if (exportsField && typeof exportsField === "object") {
    const walk = (value: unknown) => {
      if (!value) return
      if (typeof value === "string") {
        pushIfDts(value)
        return
      }
      if (Array.isArray(value)) {
        for (const v of value) walk(v)
        return
      }
      if (typeof value === "object") {
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          if (k === "types" || k === "typings") {
            walk(v)
          } else {
            walk(v)
          }
        }
      }
    }
    walk(exportsField)
  }

  pushIfDts("index.d.ts")
  pushIfDts("dist/index.d.ts")
  pushIfDts("lib/index.d.ts")
  pushIfDts("types/index.d.ts")

  if (entries.length === 0 && typeof pj.main === "string") {
    const guess = (pj.main as string).replace(/\.(mjs|cjs|js)$/i, ".d.ts")
    pushIfDts(guess)
  }

  return entries
}

export function findAnchorTsFile(workspaceRoot: string): string | null {
  const candidates = [
    join(workspaceRoot, "src"),
    join(workspaceRoot, "lib"),
    workspaceRoot,
  ]
  for (const dir of candidates) {
    const found = findFirstTs(dir, 3)
    if (found) return found
  }
  return null
}

function findFirstTs(dir: string, depth: number): string | null {
  if (!existsSync(dir)) return null
  if (!isDir(dir)) return null
  let entries: string[] = []
  try {
    entries = readdirSync(dir)
  } catch {
    return null
  }
  for (const entry of entries) {
    if (entry.startsWith(".") || entry === "node_modules" || entry === "dist") continue
    const full = join(dir, entry)
    if (isDir(full)) {
      if (depth <= 0) continue
      const found = findFirstTs(full, depth - 1)
      if (found) return found
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      return full
    }
  }
  return null
}

export async function withProbeFile<T>(
  workspaceRoot: string,
  content: string,
  fn: (probePath: string) => Promise<T>,
): Promise<T> {
  const probeDir = join(workspaceRoot, ".trae-probe")
  const probePath = join(probeDir, `probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.ts`)
  mkdirSync(probeDir, { recursive: true })
  writeFileSync(probePath, content, "utf-8")
  try {
    return await fn(probePath)
  } finally {
    try {
      rmSync(probeDir, { recursive: true, force: true })
    } catch {}
  }
}

const COMPLETION_KIND_MAP: Record<number, UnifiedSymbolKind> = {
  7: "Class",
  8: "Interface",
  22: "TypeAlias",
  13: "Enum",
  3: "Function",
  2: "Function",
  6: "Variable",
  21: "Variable",
  9: "Namespace",
  10: "Namespace",
}

export function mapCompletionKindToSymbolKind(kind: number | undefined): UnifiedSymbolKind {
  if (kind == null) return "Unknown"
  return COMPLETION_KIND_MAP[kind] ?? "Unknown"
}

function loadTs(): typeof import("typescript") | null {
  // 1) 首选：LSP 自举安装目录（server-auto-installer 已 `bun add typescript@...`）
  try {
    const { getCacheDir } = require("../ast-grep/downloader") as {
      getCacheDir: () => string
    }
    const npmCacheDir = join(getCacheDir(), "..", "npm")
    const req = createRequire(join(npmCacheDir, "__lsp_pkg_probe__.js"))
    return req("typescript") as typeof import("typescript")
  } catch {}
  // 2) 用户项目的 cwd
  try {
    const req = createRequire(join(process.cwd(), "__lsp_pkg_probe__.js"))
    return req("typescript") as typeof import("typescript")
  } catch {}
  // 3) 最后兜底：常规 require（仅在插件自身 devDeps 里存在时可用）
  try {
    return require("typescript") as typeof import("typescript")
  } catch {}
  return null
}

export function scanDtsExports(
  entryFiles: string[],
  opts: { includeReExports?: boolean; packageRoot?: string } = {},
): DtsExport[] {
  const ts = loadTs()
  if (!ts) return []

  const seen = new Set<string>()
  const results: DtsExport[] = []
  const visitedFiles = new Set<string>()

  const visitFile = (filePath: string, depth: number) => {
    if (depth > 5) return
    const abs = resolve(filePath)
    if (visitedFiles.has(abs)) return
    visitedFiles.add(abs)
    if (!existsSync(abs)) return

    let text = ""
    try {
      text = readFileSync(abs, "utf-8")
    } catch {
      return
    }
    const src = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true)
    const addResult = (item: DtsExport) => {
      const key = `${item.name}::${item.kind}`
      if (seen.has(key)) return
      seen.add(key)
      results.push(item)
    }

    const posToLineCol = (pos: number): { line: number; character: number } => {
      const lc = src.getLineAndCharacterOfPosition(pos)
      return { line: lc.line + 1, character: lc.character }
    }

    const extractSignature = (node: import("typescript").Node): string => {
      const fullText = node.getText(src)
      const firstLine = fullText.split("\n")[0] ?? fullText
      return firstLine.trim().slice(0, 200)
    }

    const hasExport = (node: import("typescript").Node): boolean => {
      const mods = (ts.canHaveModifiers?.(node) ? ts.getModifiers?.(node) : undefined) as
        | readonly import("typescript").Modifier[]
        | undefined
      return !!mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    }

    const resolveReExportPath = (spec: string): string | null => {
      if (spec.startsWith(".")) {
        const base = resolve(dirname(abs), spec)
        const cands = [
          `${base}.d.ts`,
          join(base, "index.d.ts"),
          `${base}.d.mts`,
          `${base}.d.cts`,
        ]
        for (const c of cands) {
          if (existsSync(c)) return c
        }
      }
      return null
    }

    for (const stmt of src.statements) {
      if (ts.isClassDeclaration(stmt) && stmt.name && hasExport(stmt)) {
        const pos = posToLineCol(stmt.name.getStart(src))
        addResult({
          name: stmt.name.text,
          kind: "Class",
          filePath: abs,
          line: pos.line,
          character: pos.character,
          isReExport: false,
          signature: extractSignature(stmt),
        })
      } else if (ts.isInterfaceDeclaration(stmt) && hasExport(stmt)) {
        const pos = posToLineCol(stmt.name.getStart(src))
        addResult({
          name: stmt.name.text,
          kind: "Interface",
          filePath: abs,
          line: pos.line,
          character: pos.character,
          isReExport: false,
          signature: extractSignature(stmt),
        })
      } else if (ts.isTypeAliasDeclaration(stmt) && hasExport(stmt)) {
        const pos = posToLineCol(stmt.name.getStart(src))
        addResult({
          name: stmt.name.text,
          kind: "TypeAlias",
          filePath: abs,
          line: pos.line,
          character: pos.character,
          isReExport: false,
          signature: extractSignature(stmt),
        })
      } else if (ts.isEnumDeclaration(stmt) && hasExport(stmt)) {
        const pos = posToLineCol(stmt.name.getStart(src))
        addResult({
          name: stmt.name.text,
          kind: "Enum",
          filePath: abs,
          line: pos.line,
          character: pos.character,
          isReExport: false,
          signature: extractSignature(stmt),
        })
      } else if (ts.isFunctionDeclaration(stmt) && stmt.name && hasExport(stmt)) {
        const pos = posToLineCol(stmt.name.getStart(src))
        addResult({
          name: stmt.name.text,
          kind: "Function",
          filePath: abs,
          line: pos.line,
          character: pos.character,
          isReExport: false,
          signature: extractSignature(stmt),
        })
      } else if (ts.isVariableStatement(stmt) && hasExport(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) {
            const pos = posToLineCol(decl.name.getStart(src))
            addResult({
              name: decl.name.text,
              kind: "Variable",
              filePath: abs,
              line: pos.line,
              character: pos.character,
              isReExport: false,
              signature: extractSignature(stmt),
            })
          }
        }
      } else if (ts.isModuleDeclaration(stmt) && stmt.name && hasExport(stmt)) {
        if (ts.isIdentifier(stmt.name)) {
          const pos = posToLineCol(stmt.name.getStart(src))
          addResult({
            name: stmt.name.text,
            kind: "Namespace",
            filePath: abs,
            line: pos.line,
            character: pos.character,
            isReExport: false,
            signature: extractSignature(stmt),
          })
        }
      } else if (ts.isExportDeclaration(stmt)) {
        const spec =
          stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)
            ? stmt.moduleSpecifier.text
            : null
        if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
          for (const el of stmt.exportClause.elements) {
            const pos = posToLineCol(el.name.getStart(src))
            addResult({
              name: el.name.text,
              kind: "Unknown",
              filePath: abs,
              line: pos.line,
              character: pos.character,
              isReExport: !!spec,
              signature: extractSignature(el),
            })
          }
        }
        if (spec && (opts.includeReExports ?? true)) {
          const target = resolveReExportPath(spec)
          if (target) visitFile(target, depth + 1)
        }
      } else if (ts.isExportAssignment(stmt)) {
        const pos = posToLineCol(stmt.getStart(src))
        addResult({
          name: "default",
          kind: "Default",
          filePath: abs,
          line: pos.line,
          character: pos.character,
          isReExport: false,
          signature: extractSignature(stmt),
        })
      }
    }
  }

  for (const entry of entryFiles) {
    visitFile(entry, 0)
  }

  return results
}

export function findDtsSymbol(
  entryFiles: string[],
  symbolName: string,
): DtsExport | null {
  const all = scanDtsExports(entryFiles, { includeReExports: true })
  const exact = all.find((e) => e.name === symbolName && e.kind !== "Unknown")
  if (exact) return exact
  return all.find((e) => e.name === symbolName) ?? null
}

export function isPatternPackageName(input: string): boolean {
  return isRegexLiteral(input) || GLOB_MATCH_CHARS.test(input)
}

export function toWorkspaceRoot(workspaceRoot: string | undefined, fallbackFile?: string): string {
  if (workspaceRoot && existsSync(workspaceRoot)) return resolve(workspaceRoot)
  if (fallbackFile) return resolve(dirname(fallbackFile))
  return process.cwd()
}

export function packageRootSeparator(): string {
  return sep
}

export interface PackageSymbolLocation {
  pkg: string
  filePath: string
  line: number
  character: number
  kind: UnifiedSymbolKind
}

export function resolvePackageSymbolLocations(
  packageName: string | string[],
  symbolName: string,
  workspaceRoot: string,
  maxPackages = 20,
): PackageSymbolLocation[] {
  const packages = expandPackageNames(packageName, workspaceRoot, maxPackages)
  const results: PackageSymbolLocation[] = []

  for (const pkg of packages) {
    const pkgRoot = resolvePackageRoot(pkg, workspaceRoot)
    if (!pkgRoot) continue
    const entries = getPackageDtsEntries(pkgRoot)
    if (entries.length === 0) continue
    const hit = findDtsSymbol(entries, symbolName)
    if (!hit) continue
    results.push({
      pkg,
      filePath: hit.filePath,
      line: hit.line,
      character: hit.character,
      kind: hit.kind,
    })
  }

  return results
}
