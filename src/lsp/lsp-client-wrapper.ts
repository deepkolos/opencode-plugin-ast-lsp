import { extname, resolve } from "path"
import { fileURLToPath } from "node:url"
import { existsSync, statSync } from "fs"

import { LSPClient } from "./lsp-client"
import { lspManager } from "./lsp-server"
import { findServerForExtension } from "./server-resolution"
import { ensureLspServersInstalled } from "./server-auto-installer"
import type { ServerLookupResult } from "./types"

export function isDirectoryPath(filePath: string): boolean {
  if (!existsSync(filePath)) {
    return false
  }
  return statSync(filePath).isDirectory()
}

export function uriToPath(uri: string): string {
  if (uri.startsWith("file://")) {
    return fileURLToPath(uri)
  }
  return uri
}

export function findWorkspaceRoot(filePath: string): string {
  let dir = resolve(filePath)

  if (!existsSync(dir) || !isDirectoryPath(dir)) {
    dir = require("path").dirname(dir)
  }

  const markers = [".git", "package.json", "pyproject.toml", "Cargo.toml", "go.mod", "pom.xml", "build.gradle"]

  let prevDir = ""
  while (dir !== prevDir) {
    for (const marker of markers) {
      if (existsSync(require("path").join(dir, marker))) {
        return dir
      }
    }
    prevDir = dir
    dir = require("path").dirname(dir)
  }

  return require("path").dirname(resolve(filePath))
}

function formatServerLookupError(result: Exclude<ServerLookupResult, { status: "found" }>): string {
  if (result.status === "not_installed") {
    const { server, installHint } = result
    return [
      `LSP server '${server.id}' is configured but NOT INSTALLED.`,
      ``,
      `Command not found: ${server.command[0]}`,
      ``,
      `To install:`,
      `  ${installHint}`,
      ``,
      `Supported extensions: ${server.extensions.join(", ")}`,
    ].join("\n")
  }

  return [
    `No LSP server configured for extension: ${result.extension}`,
    ``,
    `Available servers: ${result.availableServers.slice(0, 10).join(", ")}${result.availableServers.length > 10 ? "..." : ""}`,
  ].join("\n")
}

export async function withLspClient<T>(filePath: string, fn: (client: LSPClient) => Promise<T>): Promise<T> {
  const absPath = resolve(filePath)

  if (isDirectoryPath(absPath)) {
    throw new Error(`Directory paths are not supported by this LSP tool.`)
  }

  const ext = extname(absPath)
  let result = findServerForExtension(ext)

  if (result.status === "not_installed") {
    // Attempt auto-install
    await ensureLspServersInstalled()
    result = findServerForExtension(ext)
  }

  if (result.status !== "found") {
    throw new Error(formatServerLookupError(result))
  }

  const server = result.server
  const root = findWorkspaceRoot(absPath)
  const client = await lspManager.getClient(root, server)

  try {
    return await fn(client)
  } catch (e) {
    if (e instanceof Error && e.message.includes("timeout")) {
      const isInitializing = lspManager.isServerInitializing(root, server.id)
      if (isInitializing) {
        throw new Error(`LSP server is still initializing. Please retry in a few seconds.`)
      }
    }
    throw e
  } finally {
    lspManager.releaseClient(root, server.id)
  }
}
