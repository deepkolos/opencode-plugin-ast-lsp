import { SYMBOL_KIND_MAP, SEVERITY_MAP } from "./language-mappings"
import type {
  Diagnostic,
  DocumentSymbol,
  Location,
  LocationLink,
  PrepareRenameDefaultBehavior,
  PrepareRenameResult,
  Range,
  SymbolInfo,
  TextEdit,
  WorkspaceEdit,
} from "./types"

export function formatLocation(loc: Location | LocationLink): string {
  if ("targetUri" in loc) {
    const uri = loc.targetUri
    const filePath = uri.startsWith("file://") ? uri.substring(7) : uri
    const line = loc.targetRange.start.line + 1
    const char = loc.targetRange.start.character
    return `${filePath}:${line}:${char}`
  }

  const uri = loc.uri
  const filePath = uri.startsWith("file://") ? uri.substring(7) : uri
  const line = loc.range.start.line + 1
  const char = loc.range.start.character
  return `${filePath}:${line}:${char}`
}

export function formatSymbolKind(kind: number): string {
  return SYMBOL_KIND_MAP[kind] || `Unknown(${kind})`
}

export function formatSeverity(severity: number | undefined): string {
  if (!severity) return "unknown"
  return SEVERITY_MAP[severity] || `unknown(${severity})`
}

export function formatDocumentSymbol(symbol: DocumentSymbol, indent = 0): string {
  const prefix = "  ".repeat(indent)
  const kind = formatSymbolKind(symbol.kind)
  const line = symbol.range.start.line + 1
  let result = `${prefix}${symbol.name} (${kind}) - line ${line}`

  if (symbol.children && symbol.children.length > 0) {
    for (const child of symbol.children) {
      result += "\n" + formatDocumentSymbol(child, indent + 1)
    }
  }

  return result
}

export function formatSymbolInfo(symbol: SymbolInfo): string {
  const kind = formatSymbolKind(symbol.kind)
  const loc = formatLocation(symbol.location)
  const container = symbol.containerName ? ` (in ${symbol.containerName})` : ""
  return `${symbol.name} (${kind})${container} - ${loc}`
}

export function formatDiagnostic(diag: Diagnostic): string {
  const severity = formatSeverity(diag.severity)
  const line = diag.range.start.line + 1
  const char = diag.range.start.character
  const source = diag.source ? `[${diag.source}]` : ""
  const code = diag.code ? ` (${diag.code})` : ""
  return `${severity}${source}${code} at ${line}:${char}: ${diag.message}`
}

export function filterDiagnosticsBySeverity(
  diagnostics: Diagnostic[],
  severityFilter?: "error" | "warning" | "information" | "hint" | "all"
): Diagnostic[] {
  if (!severityFilter || severityFilter === "all") {
    return diagnostics
  }

  const severityMap: Record<string, number> = {
    error: 1,
    warning: 2,
    information: 3,
    hint: 4,
  }

  const targetSeverity = severityMap[severityFilter]
  return diagnostics.filter((d) => d.severity === targetSeverity)
}

export function formatPrepareRenameResult(
  result: PrepareRenameResult | PrepareRenameDefaultBehavior | Range | null
): string {
  if (!result) return "Cannot rename at this position"

  if ("defaultBehavior" in result) {
    return result.defaultBehavior ? "Rename supported (using default behavior)" : "Cannot rename at this position"
  }

  if ("range" in result && result.range) {
    const startLine = result.range.start.line + 1
    const startChar = result.range.start.character
    const endLine = result.range.end.line + 1
    const endChar = result.range.end.character
    const placeholder = result.placeholder ? ` (current: "${result.placeholder}")` : ""
    return `Rename available at ${startLine}:${startChar}-${endLine}:${endChar}${placeholder}`
  }

  if ("start" in result && "end" in result) {
    const startLine = result.start.line + 1
    const startChar = result.start.character
    const endLine = result.end.line + 1
    const endChar = result.end.character
    return `Rename available at ${startLine}:${startChar}-${endLine}:${endChar}`
  }

  return "Cannot rename at this position"
}

export function formatTextEdit(edit: TextEdit): string {
  const startLine = edit.range.start.line + 1
  const startChar = edit.range.start.character
  const endLine = edit.range.end.line + 1
  const endChar = edit.range.end.character

  const rangeStr = `${startLine}:${startChar}-${endLine}:${endChar}`
  const preview = edit.newText.length > 50 ? edit.newText.substring(0, 50) + "..." : edit.newText

  return `  ${rangeStr}: "${preview}"`
}

export function formatWorkspaceEdit(edit: WorkspaceEdit | null): string {
  if (!edit) return "No changes"

  const lines: string[] = []

  if (edit.changes) {
    for (const [uri, edits] of Object.entries(edit.changes)) {
      const filePath = uri.startsWith("file://") ? uri.substring(7) : uri
      lines.push(`File: ${filePath}`)
      for (const textEdit of edits) {
        lines.push(formatTextEdit(textEdit))
      }
    }
  }

  if (edit.documentChanges) {
    for (const change of edit.documentChanges) {
      if ("kind" in change) {
        if (change.kind === "create") {
          const filePath = change.uri.startsWith("file://") ? change.uri.substring(7) : change.uri
          lines.push(`Create: ${filePath}`)
        } else if (change.kind === "rename") {
          const oldPath = change.oldUri.startsWith("file://") ? change.oldUri.substring(7) : change.oldUri
          const newPath = change.newUri.startsWith("file://") ? change.newUri.substring(7) : change.newUri
          lines.push(`Rename: ${oldPath} -> ${newPath}`)
        } else if (change.kind === "delete") {
          const filePath = change.uri.startsWith("file://") ? change.uri.substring(7) : change.uri
          lines.push(`Delete: ${filePath}`)
        }
      } else {
        const filePath = change.textDocument.uri.startsWith("file://") ? change.textDocument.uri.substring(7) : change.textDocument.uri
        lines.push(`File: ${filePath}`)
        for (const textEdit of change.edits) {
          lines.push(formatTextEdit(textEdit))
        }
      }
    }
  }

  if (lines.length === 0) return "No changes"

  return lines.join("\n")
}
