import { join } from "path"
import { getCacheDir } from "../ast-grep/downloader"

export function getLspServerAdditionalPathBases(workingDirectory: string): string[] {
  const lspCacheDir = join(getCacheDir(), "..", "npm", "node_modules", ".bin")

  return [
    join(workingDirectory, "node_modules", ".bin"),
    lspCacheDir,
  ]
}
