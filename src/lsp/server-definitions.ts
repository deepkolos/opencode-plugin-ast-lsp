import type { LSPServerConfig } from "./types"

export const LSP_INSTALL_HINTS: Record<string, string> = {
  typescript: "npm install -g typescript-language-server typescript",
  eslint: "npm install -g vscode-langservers-extracted",
}

export const BUILTIN_SERVERS: Record<string, Omit<LSPServerConfig, "id">> = {
  typescript: { command: ["typescript-language-server", "--stdio"], extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"] },
  eslint: { command: ["vscode-eslint-language-server", "--stdio"], extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"] },
}
