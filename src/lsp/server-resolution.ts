import { BUILTIN_SERVERS, LSP_INSTALL_HINTS } from "./server-definitions"
import { isServerInstalled } from "./server-installation"
import type { ServerLookupResult, ResolvedServer } from "./types"

export function findServerForExtension(ext: string): ServerLookupResult {
  const servers = Object.entries(BUILTIN_SERVERS).map(([id, config]) => ({
    ...config,
    id,
  }))

  for (const server of servers) {
    if (server.extensions.includes(ext) && isServerInstalled(server.command)) {
      return {
        status: "found",
        server: {
          id: server.id,
          command: server.command,
          extensions: server.extensions,
          priority: 0,
          env: server.env,
          initialization: server.initialization,
        } as ResolvedServer,
      }
    }
  }

  for (const server of servers) {
    if (server.extensions.includes(ext)) {
      const installHint = LSP_INSTALL_HINTS[server.id] || `Install '${server.command[0]}' and ensure it's in your PATH`
      return {
        status: "not_installed",
        server: {
          id: server.id,
          command: server.command,
          extensions: server.extensions,
        },
        installHint,
      }
    }
  }

  const availableServers = [...new Set(servers.map((s) => s.id))]
  return {
    status: "not_configured",
    extension: ext,
    availableServers,
  }
}
