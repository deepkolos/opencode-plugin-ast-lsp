import { join } from "path"
import { existsSync, mkdirSync } from "fs"
import { getCacheDir } from "../ast-grep/downloader"
import { getPluginInput } from "../shared/plugin-context"
import { log } from "../shared/logger"
import { PUBLISHED_PACKAGE_NAME } from "../shared/plugin-identity"

let isInstalling = false

export async function ensureLspServersInstalled(): Promise<void> {
  const npmCacheDir = join(getCacheDir(), "..", "npm")
  const binDir = join(npmCacheDir, "node_modules", ".bin")

  if (existsSync(join(binDir, "typescript-language-server")) && existsSync(join(binDir, "vscode-eslint-language-server"))) {
    return
  }

  if (isInstalling) {
    return
  }

  isInstalling = true
  log(`[${PUBLISHED_PACKAGE_NAME}] Missing LSP servers. Auto-installing typescript-language-server and eslint-language-server to ${npmCacheDir}...`)

  try {
    if (!existsSync(npmCacheDir)) {
      mkdirSync(npmCacheDir, { recursive: true })
    }

    const { $ } = getPluginInput()
    
    // Create a dummy package.json if it doesn't exist to prevent climbing up the directory tree
    if (!existsSync(join(npmCacheDir, "package.json"))) {
      require("fs").writeFileSync(join(npmCacheDir, "package.json"), '{"name":"opencode-plugin-ast-lsp-npm-cache","private":true}')
    }

    // Using current bun executable to install the language servers
    const bunPath = process.execPath
    await $`${bunPath} add --exact typescript@6.0.3 typescript-language-server@5.1.3 vscode-langservers-extracted@4.10.0`
      .cwd(npmCacheDir)
      .env({
        ...process.env,
        BUN_BE_BUN: "1",
      })

    log(`[${PUBLISHED_PACKAGE_NAME}] LSP servers installed successfully.`)
  } catch (err) {
    log(`[${PUBLISHED_PACKAGE_NAME}] Failed to auto-install LSP servers: ${err}`)
  } finally {
    isInstalling = false
  }
}
