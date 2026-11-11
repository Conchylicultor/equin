// ── A browser host's worker entry, end to end ───────────────────────────────
//
// What every host root (`bin/browser-host.ts`) does around its own boot, in one
// place: take the pages' ends (a SharedWorker's connections, or a dedicated
// worker's own port), open and declare the storage, boot on it, record it
// booted, and wire Reset and the handoff to a newer build. The root keeps only
// its policy: the storage it asks for — a demo's starts from the snapshot its
// build took, a local app's empty — and what it tells the person about a boot.

import {
  retireLockName,
  serveHost,
  type HostBooted,
  type PortEnd,
  type ServedHost,
} from "@plugins/framework/plugins/browser-server/core";
import { declareHostStorage } from "./host-storage";
import {
  openHostStorage,
  type HostStorageOrigin,
  type HostStorageStart,
  type OpenedHostStorage,
} from "./open";

/** The worker's global scope, as much of it as this needs. */
export interface WorkerScope extends PortEnd {
  addEventListener(
    type: "message" | "connect",
    listener: (event: MessageEvent) => void,
  ): void;
  close(): void;
  /** A SharedWorker's name (what its pages connect by); a dedicated worker's, unused. */
  readonly name: string;
  /** The worker's script URL: which build it runs (content-addressed). */
  readonly location: { readonly href: string };
}

export type BrowserHostStorage =
  | { kind: "memory" }
  | {
      kind: "persistent";
      name: string;
      migrations: readonly string[];
      /** The snapshot a fresh storage starts from (and the app's policy for data from an older one). */
      start?: HostStorageStart;
    };

function originLabel(origin: HostStorageOrigin): string {
  switch (origin.kind) {
    case "stored":
      return "stored";
    case "empty":
      return "empty";
    case "snapshot":
      return origin.replacedOutdated
        ? "snapshot (replacing data from an older one)"
        : "snapshot";
  }
}

/**
 * Serve the host in this worker: every page end — each connection when it runs
 * as a SharedWorker (`"onconnect" in self`), else the worker's own port — gets
 * the host `boot` returns, booted on the `storage` declared before it runs.
 * `boot` sees where the storage's data comes from (`origin`). A page's Reset
 * wipes the storage and ends the worker (the pages reconnect to a fresh one).
 * When the same host already serves the storage as another SharedWorker, this
 * one declines (`{ kind: "join", worker }`) and its pages connect to that one;
 * another build claiming the storage ends serving here first (`updated`).
 *
 * As a SharedWorker, the host outlives its last tab (the page starts it with
 * `extendedLifetime`) and retires once no page holds it: every request
 * finished, the storage closed — everything flushed to IndexedDB, its lock
 * released — then the worker (`serveHost`'s `retire`).
 */
export function serveBrowserHost(opts: {
  scope: WorkerScope;
  storage: BrowserHostStorage;
  boot: (storage: OpenedHostStorage) => Promise<HostBooted>;
}): void {
  // The worker's clock starts when it is created: what passed before its
  // entry ran is fetching and evaluating the worker's module graph.
  const scriptMs = Math.round(performance.now());
  const { scope } = opts;
  const shared = "onconnect" in scope;
  let storage: OpenedHostStorage | null = null;
  const served: ServedHost = serveHost({
    accept(serve) {
      if (shared) {
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
      const opening = performance.now();
      storage = await openHostStorage(
        opts.storage.kind === "memory"
          ? opts.storage
          : {
              ...opts.storage,
              // A tab of the same host joins this one (`ownership.ts`): only
              // a SharedWorker can be joined, by its name.
              identity: {
                build: scope.location.href,
                worker: shared ? scope.name : null,
              },
              onSuperseded: async (why) => served.end(why),
            },
      );
      declareHostStorage(storage);
      const openedMs = Math.round(performance.now() - opening);
      try {
        const host = await opts.boot(storage);
        await storage.booted();
        // The boot report says where the data came from, what loading the
        // worker's own code cost, and what opening the storage cost (a
        // snapshot's load included) before the graph booted.
        return {
          ...host,
          boot: {
            ...host.boot,
            stages: [
              { name: "script", ms: scriptMs },
              { name: "storage", ms: openedMs },
              ...host.boot.stages,
            ],
            data: originLabel(storage.origin),
            createdAt: performance.timeOrigin,
          },
        };
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
    // A dedicated worker closes here, whatever ended it (its page starts
    // another, or shows why); a SharedWorker retires instead, under its
    // retire lock.
    onEnded: () => {
      if (!shared) scope.close();
    },
    retire: shared
      ? {
          lock: retireLockName(scope.name),
          async run() {
            try {
              // Everything flushed, then the lock released: the next worker
              // opens what this one wrote.
              await storage?.close();
            } finally {
              scope.close();
            }
          },
        }
      : undefined,
  });
}
