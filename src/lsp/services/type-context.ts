import { existsSync, readFileSync } from "fs"
import { dirname, resolve } from "path"

import ts from "typescript"

import type { LocationRef } from "../tool-result"
import type { Position } from "../types"

const PRIMITIVE_OR_GLOBAL_TYPES = new Set([
  "Array",
  "ReadonlyArray",
  "Promise",
  "Record",
  "Partial",
  "Required",
  "Readonly",
  "Pick",
  "Omit",
  "Exclude",
  "Extract",
  "NonNullable",
  "Parameters",
  "ReturnType",
  "ConstructorParameters",
  "InstanceType",
  "Awaited",
  "String",
  "Number",
  "Boolean",
  "Object",
  "Date",
  "RegExp",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Error",
])

export type TypeContextMode = "surface" | "deep"

export interface TypeContextOptions {
  filePath: string
  line: number
  character: number
  mode: TypeContextMode
  maxDepth: number
  maxTypes: number
  maxBytes: number
}

export type UnresolvedTypeReason =
  | "maxDepth"
  | "maxTypes"
  | "maxBytes"
  | "external-lib"
  | "unresolved"
  | "circular"

export interface RelatedTypeInfo {
  name: string
  kind?: string
  location: LocationRef
  text: string
  depth: number
}

export interface UnresolvedTypeInfo {
  name: string
  reason: UnresolvedTypeReason
  location?: LocationRef
}

export interface TypeContextInfo {
  relatedTypes: RelatedTypeInfo[]
  unresolvedTypes: UnresolvedTypeInfo[]
  truncated: boolean
}

function offsetAt(source: ts.SourceFile, position: Position): number {
  return source.getPositionOfLineAndCharacter(position.line, position.character)
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
}

function characterOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).character
}

function nodeContainsPosition(node: ts.Node, position: number): boolean {
  return node.getFullStart() <= position && position <= node.getEnd()
}

function findSmallestNodeAtPosition(source: ts.SourceFile, position: number): ts.Node | null {
  let best: ts.Node | null = null
  const visit = (node: ts.Node) => {
    if (!nodeContainsPosition(node, position)) return
    best = node
    ts.forEachChild(node, visit)
  }
  visit(source)
  return best
}

function nearestDeclaration(node: ts.Node | null): ts.Declaration | null {
  let current: ts.Node | undefined = node ?? undefined
  while (current) {
    if (
      ts.isClassDeclaration(current) ||
      ts.isInterfaceDeclaration(current) ||
      ts.isTypeAliasDeclaration(current) ||
      ts.isEnumDeclaration(current) ||
      ts.isFunctionDeclaration(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isConstructorDeclaration(current) ||
      ts.isPropertyDeclaration(current) ||
      ts.isPropertySignature(current) ||
      ts.isMethodSignature(current) ||
      ts.isVariableDeclaration(current)
    ) {
      return current
    }
    current = current.parent
  }
  return null
}

function declarationName(node: ts.Declaration): string | null {
  const name = (node as ts.Declaration & { name?: ts.Node }).name
  if (!name) return null
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text
  }
  return name.getText()
}

function isExportedOrPublic(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined
  if (!modifiers) return true
  return !modifiers.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword)
}

function typeNodeFromDeclaration(node: ts.Node): ts.TypeNode | undefined {
  if (
    ts.isParameter(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isPropertySignature(node) ||
    ts.isVariableDeclaration(node)
  ) {
    return node.type
  }
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isCallSignatureDeclaration(node) ||
    ts.isConstructSignatureDeclaration(node)
  ) {
    return node.type
  }
  if (ts.isTypeAliasDeclaration(node)) return node.type
  return undefined
}

function collectReferencesFromNode(node: ts.Node, output: ts.EntityName[]): void {
  const visit = (child: ts.Node) => {
    if (ts.isTypeReferenceNode(child)) {
      output.push(child.typeName)
    } else if (ts.isExpressionWithTypeArguments(child)) {
      const expr = child.expression
      if (ts.isIdentifier(expr) || ts.isQualifiedName(expr)) output.push(expr)
    }
    ts.forEachChild(child, visit)
  }
  visit(node)
}

function collectRootReferences(root: ts.Declaration): ts.EntityName[] {
  const refs: ts.EntityName[] = []

  if (ts.isClassDeclaration(root)) {
    for (const member of root.members) {
      if (!isExportedOrPublic(member)) continue
      collectReferencesFromNode(member, refs)
    }
    if (root.heritageClauses) {
      for (const clause of root.heritageClauses) collectReferencesFromNode(clause, refs)
    }
    return refs
  }

  if (ts.isInterfaceDeclaration(root)) {
    for (const member of root.members) collectReferencesFromNode(member, refs)
    if (root.heritageClauses) {
      for (const clause of root.heritageClauses) collectReferencesFromNode(clause, refs)
    }
    return refs
  }

  if (
    ts.isFunctionDeclaration(root) ||
    ts.isMethodDeclaration(root) ||
    ts.isMethodSignature(root) ||
    ts.isCallSignatureDeclaration(root) ||
    ts.isConstructSignatureDeclaration(root)
  ) {
    for (const param of root.parameters) {
      if (param.type) collectReferencesFromNode(param.type, refs)
    }
    if (root.type) collectReferencesFromNode(root.type, refs)
    return refs
  }

  const typeNode = typeNodeFromDeclaration(root)
  if (typeNode) collectReferencesFromNode(typeNode, refs)
  return refs
}

function compactDeclarationText(source: ts.SourceFile, node: ts.Declaration): string {
  const raw = source.getFullText().slice(node.getFullStart(), node.getEnd()).trim()
  return raw
    .split("\n")
    .map((line) => line.replace(/\s+$/g, ""))
    .join("\n")
    .trim()
}

function declarationSortKey(node: ts.Declaration): number {
  if (ts.isInterfaceDeclaration(node)) return 1
  if (ts.isTypeAliasDeclaration(node)) return 2
  if (ts.isEnumDeclaration(node)) return 3
  if (ts.isClassDeclaration(node)) return 4
  if (ts.isFunctionDeclaration(node)) return 5
  return 9
}

function declarationKind(node: ts.Declaration): string {
  if (ts.isInterfaceDeclaration(node)) return "Interface"
  if (ts.isTypeAliasDeclaration(node)) return "TypeAlias"
  if (ts.isEnumDeclaration(node)) return "Enum"
  if (ts.isClassDeclaration(node)) return "Class"
  if (ts.isFunctionDeclaration(node)) return "Function"
  if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) return "Method"
  if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) return "Property"
  if (ts.isVariableDeclaration(node)) return "Variable"
  return "Unknown"
}

function declarationForSymbol(symbol: ts.Symbol): ts.Declaration | null {
  const declarations = symbol.getDeclarations() ?? []
  const useful = declarations
    .filter((decl) => !isExternalLibDeclaration(decl))
    .sort((a, b) => declarationSortKey(a) - declarationSortKey(b))
  return useful[0] ?? null
}

function entityNameText(name: ts.EntityName): string {
  if (ts.isIdentifier(name)) return name.text
  return name.right.text
}

function isExternalLibDeclaration(node: ts.Node): boolean {
  const file = node.getSourceFile().fileName
  return /[/\\]typescript[/\\]lib[/\\]lib\..*\.d\.ts$/.test(file)
}

function isNodeModulesInternal(rootFile: string, declFile: string): boolean {
  const root = resolve(rootFile)
  const decl = resolve(declFile)
  if (!decl.includes(`${resolve("node_modules")}`)) return false
  if (dirname(decl).startsWith(dirname(root))) return false
  return false
}

function createProgram(filePath: string): ts.Program {
  return ts.createProgram([filePath], {
    allowJs: true,
    checkJs: false,
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
  })
}

function resolveReference(
  checker: ts.TypeChecker,
  ref: ts.EntityName,
): { name: string; declaration: ts.Declaration | null; reason?: string } {
  const name = entityNameText(ref)
  if (PRIMITIVE_OR_GLOBAL_TYPES.has(name)) {
    return { name, declaration: null, reason: "global-or-utility-type" }
  }

  const symbol = checker.getSymbolAtLocation(ref)
  const aliased = symbol && (symbol.flags & ts.SymbolFlags.Alias)
    ? checker.getAliasedSymbol(symbol)
    : symbol
  if (!aliased) return { name, declaration: null, reason: "unresolved" }

  const declaration = declarationForSymbol(aliased)
  if (!declaration) return { name, declaration: null, reason: "unresolved" }
  if (isExternalLibDeclaration(declaration)) return { name, declaration: null, reason: "external-lib" }
  return { name, declaration }
}

export function collectTypeContextInfo(options: TypeContextOptions): TypeContextInfo {
  if (!existsSync(options.filePath)) {
    return { relatedTypes: [], unresolvedTypes: [], truncated: false }
  }

  const program = createProgram(options.filePath)
  const checker = program.getTypeChecker()
  const source = program.getSourceFile(options.filePath)
  if (!source) return { relatedTypes: [], unresolvedTypes: [], truncated: false }

  const pos = offsetAt(source, { line: options.line - 1, character: options.character })
  const root = nearestDeclaration(findSmallestNodeAtPosition(source, pos))
  if (!root) return { relatedTypes: [], unresolvedTypes: [], truncated: false }

  const maxDepth = options.mode === "deep" ? options.maxDepth : Math.min(options.maxDepth, 1)
  const collected: RelatedTypeInfo[] = []
  const skipped: UnresolvedTypeInfo[] = []
  const seen = new Set<string>()
  let usedBytes = 0
  let truncated = false

  const enqueueSkipped = (item: UnresolvedTypeInfo) => {
    const key = `${item.name}:${item.reason}:${item.location?.filePath ?? ""}`
    if (seen.has(`skipped:${key}`)) return
    seen.add(`skipped:${key}`)
    skipped.push(item)
  }

  const visitDeclaration = (decl: ts.Declaration, depth: number) => {
    const refs = collectRootReferences(decl)
    for (const ref of refs) {
      const resolved = resolveReference(checker, ref)
      if (!resolved.declaration) {
        if (resolved.reason && resolved.reason !== "global-or-utility-type") {
          enqueueSkipped({ name: resolved.name, reason: resolved.reason as UnresolvedTypeReason })
        }
        continue
      }

      const refSource = resolved.declaration.getSourceFile()
      const filePath = refSource.fileName
      const key = `${resolved.name}:${filePath}:${resolved.declaration.pos}:${resolved.declaration.end}`
      if (seen.has(key)) continue
      if (isNodeModulesInternal(options.filePath, filePath)) {
        enqueueSkipped({
          name: resolved.name,
          reason: "external-lib",
          location: {
            filePath,
            line: lineOf(refSource, resolved.declaration),
            character: characterOf(refSource, resolved.declaration),
          },
        })
        continue
      }
      if (collected.length >= options.maxTypes) {
        truncated = true
        enqueueSkipped({
          name: resolved.name,
          reason: "maxTypes",
          location: {
            filePath,
            line: lineOf(refSource, resolved.declaration),
            character: characterOf(refSource, resolved.declaration),
          },
        })
        continue
      }
      if (depth > maxDepth) {
        truncated = true
        enqueueSkipped({
          name: resolved.name,
          reason: "maxDepth",
          location: {
            filePath,
            line: lineOf(refSource, resolved.declaration),
            character: characterOf(refSource, resolved.declaration),
          },
        })
        continue
      }

      const text = compactDeclarationText(refSource, resolved.declaration)
      const nextBytes = usedBytes + text.length
      if (nextBytes > options.maxBytes) {
        truncated = true
        enqueueSkipped({
          name: resolved.name,
          reason: "maxBytes",
          location: {
            filePath,
            line: lineOf(refSource, resolved.declaration),
            character: characterOf(refSource, resolved.declaration),
          },
        })
        continue
      }

      seen.add(key)
      usedBytes = nextBytes
      collected.push({
        name: resolved.name,
        kind: declarationKind(resolved.declaration),
        location: {
          filePath,
          line: lineOf(refSource, resolved.declaration),
          character: characterOf(refSource, resolved.declaration),
        },
        text,
        depth,
      })

      if (depth < maxDepth) {
        visitDeclaration(resolved.declaration, depth + 1)
      }
    }
  }

  visitDeclaration(root, 1)

  return { relatedTypes: collected, unresolvedTypes: skipped, truncated }
}

export function formatTypeContext(info: TypeContextInfo): string {
  const lines: string[] = []
  if (info.relatedTypes.length > 0) {
    lines.push("Related Types:")
    for (const item of info.relatedTypes) {
      lines.push("")
      lines.push(`${item.name} - ${item.location.filePath}:${item.location.line}`)
      lines.push("```ts")
      lines.push(item.text)
      lines.push("```")
    }
  }

  if (info.unresolvedTypes.length > 0) {
    lines.push("")
    lines.push("Need More Context:")
    for (const item of info.unresolvedTypes) {
      const location = item.location?.filePath ? ` (${item.location.filePath})` : ""
      lines.push(`- ${item.name}: skipped due to ${item.reason}.${location}`)
    }
  }

  return lines.join("\n").trim()
}

export function collectTypeContext(options: TypeContextOptions): string {
  return formatTypeContext(collectTypeContextInfo(options))
}
