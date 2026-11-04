// ── A browser host's worker entry, end to end ───────────────────────────────
//
// What every host root (`bin/browser-host.ts`) does around its own boot, in one
// place: take the pages' ends (a SharedWorker's connections, or a dedicated
// worker's own port), open and declare the storage, boot on it, record it
// booted, and wire Reset and the handoff to a newer build. The root keeps only
// its policy: the storage it asks for and what its boot does on a fresh one
// (a demo seeds; a local app starts empty).

import {
  serveHost,
  type HostBooted,
  type PortEnd,
  type ServedHost,
} from "@plugins/framework/plugins/browser-server/core";
import { declareHostStorage } from "./host-storage";
import { openHostStorage, type OpenedHostStorage } from "./open";

/** The worker's global scope, as much of it as this needs. */
export interface WorkerScope extends PortEnd {
  addEventListener(
    type: "message" | "connect",
    listener: (event: MessageEvent) => void,
  ): void;
  close(): void;
}

export type BrowserHostStorage =
  | { kind: "memory" }
  | { kind: "persistent"; name: string; migrations: readonly string[] };

/**
 * Serve the host in this worker: every page end — each connection when it runs
 * as a SharedWorker (`"onconnect" in self`), else the worker's own port — gets
 * the host `boot` returns, booted on the `storage` declared before it runs.
 * `boot` sees whether the storage is fresh (nothing in it yet). A page's Reset
 * wipes the storage and ends the worker (the pages reconnect to a fresh one);
 * a newer build claiming the storage ends serving here first.
 */
export function serveBrowserHost(opts: {
  scope: WorkerScope;
  storage: BrowserHostStorage;
  boot: (storage: OpenedHostStorage) => Promise<HostBooted>;
}): void {
  const { scope } = opts;
  let storage: OpenedHostStorage | null = null;
  const served: ServedHost = serveHost({
    accept(serve) {
      if ("onconnect" in scope) {
        scope.addEventListener("connect", (event: MessageEvent) => {
          const port = event.ports[0]!;
          serve(port);
          // `addEventListener` alone does not start a MessagePort.
          port.start();
        });
      } else {
        serve(scope);
      }
    },
    async boot() {
      storage = await openHostStorage(
        opts.storage.kind === "memory"
          ? opts.storage
          : {
              ...opts.storage,
              onSuperseded: async () => served.end("superseded"),
            },
      );
      declareHostStorage(storage);
      try {
        const host = await opts.boot(storage);
        await storage.booted();
        return host;
      } catch (err) {
        // A host that cannot boot holds the storage for nothing: release it,
        // so another tab (or a fixed build) can open it.
        await storage.close();
        throw err;
      }
    },
    async reset() {
      if (storage === null) {
        throw new Error("[host-storage] reset before the storage opened");
      }
      await storage.wipe();
    },
    // Reset: a closing worker is never matched by a new SharedWorker, so the
    // pages that reconnect start a fresh one.
    onEnded: (why) => {
      if (why === "reset") scope.close();
    },
  });
}
