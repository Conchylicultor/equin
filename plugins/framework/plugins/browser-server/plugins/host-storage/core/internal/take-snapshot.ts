// ── Taking a host's snapshot ────────────────────────────────────────────────
//
// What a build runs ONCE per snapshot address (`web-artifacts`, through the
// host's `bin/browser-host.snapshot.ts`, in a fresh process): boot the host's
// own graph on a storage that keeps everything in memory and records every
// store write, let its boot fill it (a demo's seed), wait until it is settled,
// then take the database's data directory and every store's entries as one
// snapshot file (`./snapshot.ts`). The database opens from the initialized
// cluster the build hands over (initdb's output for this PGlite build), so a
// take never runs initdb.

import {
  declareHostStorage,
  type HostStorage,
  type HostStorageResource,
  type HostStore,
} from "./host-storage";
import { encodeHostSnapshot } from "./snapshot";

/**
 * Boot a host on a recording in-memory storage and return its whole state as
 * a snapshot file. `boot` boots the graph (and fills it); `settled` is what it
 * waits for before the state is taken (the host's settled phase). Call once
 * per process: the storage is declared process-wide.
 */
export async function takeHostSnapshot(opts: {
  /** The migration hashes the booted graph's database applies. */
  migrations: readonly string[];
  /** An initialized, empty cluster's data directory: what the database opens from. */
  cluster: Blob;
  boot: () => Promise<{ settled: Promise<void> }>;
}): Promise<Uint8Array> {
  const stores = new Map<string, Map<string, unknown>>();
  const resources: HostStorageResource[] = [];
  const storage: HostStorage = {
    kind: "memory",
    databaseDir: undefined,
    databaseStart: { from: "initialized", dataDir: opts.cluster },
    store<V>(name: string): HostStore<V> {
      let entries = stores.get(name);
      if (entries === undefined) stores.set(name, (entries = new Map()));
      const recorded = entries;
      return {
        loaded: new Map<string, V>(),
        put: (key, value) => void recorded.set(key, value),
        delete: (key) => void recorded.delete(key),
      };
    },
    adopt(resource) {
      resources.push(resource);
    },
  };
  declareHostStorage(storage);
  const host = await opts.boot();
  await host.settled;
  if (resources.length !== 1) {
    throw new Error(
      `[host-snapshot] expected the booted host to hand its storage one database, got ${resources.length}`,
    );
  }
  const takenAt = Date.now();
  const database = await resources[0]!.dump();
  return encodeHostSnapshot({
    takenAt,
    migrations: [...opts.migrations],
    database,
    stores: Object.fromEntries(
      [...stores].map(([name, entries]) => [name, [...entries]]),
    ),
  });
}
