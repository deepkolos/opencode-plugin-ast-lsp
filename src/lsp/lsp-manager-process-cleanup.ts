type ManagedClientForCleanup = {
  client: {
    stop: () => Promise<void>
  }
}

type ProcessCleanupOptions = {
  getClients: () => IterableIterator<[string, ManagedClientForCleanup]>
  clearClients: () => void
  clearCleanupInterval: () => void
}

export type LspProcessCleanupHandle = {
  unregister: () => void
}

export function registerLspManagerProcessCleanup(options: ProcessCleanupOptions): LspProcessCleanupHandle {
  const syncCleanup = () => {
    for (const [, managed] of options.getClients()) {
      try {
        void managed.client.stop()
      } catch {}
    }
    options.clearClients()
    options.clearCleanupInterval()
  }

  const signalCleanup = () => void (async () => {
    const stopPromises: Promise<void>[] = []
    for (const [, managed] of options.getClients()) {
      stopPromises.push(managed.client.stop().catch(() => {}))
    }
    await Promise.allSettled(stopPromises)
    options.clearClients()
    options.clearCleanupInterval()
  })()

  process.on("exit", syncCleanup)
  process.on("SIGINT", signalCleanup)
  process.on("SIGTERM", signalCleanup)
  if (process.platform === "win32") {
    process.on("SIGBREAK", signalCleanup)
  }

  return {
    unregister: () => {
      process.off("exit", syncCleanup)
      process.off("SIGINT", signalCleanup)
      process.off("SIGTERM", signalCleanup)
      if (process.platform === "win32") {
        process.off("SIGBREAK", signalCleanup)
      }
    },
  }
}
