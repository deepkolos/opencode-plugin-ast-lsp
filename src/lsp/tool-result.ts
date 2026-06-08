import { fileURLToPath } from "node:url"

import type { Location, LocationLink } from "./types"
import type { LocationRef } from "../shared/tool-result"

export * from "../shared/tool-result"

export function uriToFilePath(uri: string): string {
  return uri.startsWith("file://") ? fileURLToPath(uri) : uri
}

export function locationToRef(loc: Location | LocationLink): LocationRef {
  if ("targetUri" in loc) {
    return {
      filePath: uriToFilePath(loc.targetUri),
      line: loc.targetRange.start.line + 1,
      character: loc.targetRange.start.character,
      range: loc.targetRange,
    }
  }

  return {
    filePath: uriToFilePath(loc.uri),
    line: loc.range.start.line + 1,
    character: loc.range.start.character,
    range: loc.range,
  }
}

export function firstLocation(definition: unknown): Location | LocationLink | null {
  if (!definition) return null
  if (Array.isArray(definition)) {
    return (definition[0] as Location | LocationLink | undefined) ?? null
  }
  return definition as Location | LocationLink
}
