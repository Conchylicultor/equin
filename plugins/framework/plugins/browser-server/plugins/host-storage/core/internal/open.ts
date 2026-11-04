// ── Opening a browser host's storage ─────────────────────────────────────────
//
// `openHostStorage` is what a worker's entry point calls before it boots: it
// returns the storage to declare (`declareHostStorage`) plus its lifecycle —
// whether it is `fresh` (so the caller seeds it, or starts empty), `booted()`
// once the host is up on it, `close()` and `wipe()`.
//
// A persistent storage `<name>` is, in IndexedDB:
// - `equin-host--<name>--db` — PGlite's data dir (`idb://…`);
// - `equin-host--<name>--stores` — the host stores' entries, keyed
//   [store, key], and the lifecycle record (`meta`/`lifecycle`).
//
// The lifecycle record says what the data is:
// - `state: "seeding"` — a first boot is (or was) filling it. Found at open, the
//   boot that wrote it died mid-way (a closed tab), so the storage is wiped and
//   filled again: never half a seed.
// - `state: "ready"` — booted (and seeded, when its first boot seeded it).
// - `migrations` — the migration hashes of the code that last booted on it. One
//   this code does not know means newer code migrated the data: refused
//   (`StorageNewerThanCodeError`) before anything touches it — old code would
//   otherwise boot over the new schema (the runner only logs an applied hash it
//   has no file for) and rebuild its old derived views on it.

import { idbDelete, idbDone, idbOpen, idbRequest } from "./idb";
import { StorageNewerThanCodeError } from "./errors";
import type {
  HostStorage,
  HostStorageResource,
  HostStore,
} from "./host-storage";
import { memoryHostStorage } from "./host-storage";
import { acquireOwnership, type Ownership } from "./ownership";

export type HostStorageSpec =
  /** Lost with the worker: every open is fresh. */
  | { kind: "memory" }
  | {
      kind: "persistent";
      /** Names the storage: one per app the browser keeps (`demo-lumen`). */
      name: string;
      /** Every migration hash this code's bundle carries. */
      migrations: readonly string[];
      /**
       * Newer (or the same) code claimed the storage from this worker: end
       * serving — tell the tabs, answer nothing more. The storage closes once
       * it resolves.
       */
      onSuperseded: () => Promise<void>;
    };

/** An open storage, as its worker's entry point holds it. */
export interface OpenedHostStorage extends HostStorage {
  /** Nothing in it yet: the caller seeds it (or starts empty). */
  readonly fresh: boolean;
  /** The host booted on it (and, when fresh, filled it): record it as ready. */
  booted(): Promise<void>;
  /** Flush and close it, and everything it adopted; nothing writes after. */
  close(): Promise<void>;
  /** Close it, then delete everything it holds. */
  wipe(): Promise<void>;
}

interface Lifecycle {
  state: "seeding" | "ready";
  migrations: string[];
}

const ENTRIES = "entries";
const META = "meta";
const LIFECYCLE_KEY = "lifecycle";

const prefixOf = (name: string): string => `equin-host--${name}--`;

export async function openHostStorage(
  spec: HostStorageSpec,
): Promise<OpenedHostStorage> {
  if (spec.kind === "memory") {
    return {
      ...memoryHostStorage(),
      fresh: true,
      booted: () => Promise.resolve(),
      close: () => Promise.resolve(),
      wipe: () => Promise.resolve(),
    };
  }
  let opened: OpenedHostStorage | null = null;
  const ownership = await acquireOwnership({
    name: spec.name,
    migrations: spec.migrations,
    // Claims are answered only once the storage booted (`booted()`), so it is
    // open by then.
    onSuperseded: async () => {
      if (opened === null) {
        throw new Error(
          `[host-storage] ${spec.name}: superseded before it opened`,
        );
      }
      await spec.onSuperseded();
      await opened.close();
    },
  });
  try {
    opened = await openPersistent(spec.name, spec.migrations, ownership);
    return opened;
  } catch (err) {
    ownership.release();
    throw err;
  }
}

async function openPersistent(
  name: string,
  migrations: readonly string[],
  ownership: Ownership,
): Promise<OpenedHostStorage> {
  const prefix = prefixOf(name);
  const storesName = `${prefix}stores`;
  let db = await idbOpen(storesName, [ENTRIES, META]);

  const readLifecycle = async (): Promise<Lifecycle | undefined> =>
    (await idbRequest(
      db.transaction(META).objectStore(META).get(LIFECYCLE_KEY),
    )) as Lifecycle | undefined;

  let lifecycle = await readLifecycle();
  if (lifecycle !== undefined) {
    const unknown = lifecycle.migrations.filter((m) => !migrations.includes(m));
    if (unknown.length > 0) {
      db.close();
      throw new StorageNewerThanCodeError(
        `This demo's saved data was updated by a newer version (it has ${unknown.length} migration${unknown.length === 1 ? "" : "s"} this page does not know). Reload this tab to continue.`,
      );
    }
  }
  if (lifecycle?.state === "seeding") {
    // A first boot died mid-way: start over rather than keep half a seed.
    console.warn(
      `[host-storage] ${name}: its first boot did not finish — wiping it and starting again`,
    );
    db.close();
    await deleteAll(prefix, storesName);
    db = await idbOpen(storesName, [ENTRIES, META]);
    lifecycle = undefined;
  }
  const fresh = lifecycle === undefined;
  const writeLifecycle = async (next: Lifecycle): Promise<void> => {
    const tx = db.transaction(META, "readwrite");
    tx.objectStore(META).put(next, LIFECYCLE_KEY);
    await idbDone(tx);
  };
  if (fresh)
    await writeLifecycle({ state: "seeding", migrations: [...migrations] });

  // Every store's entries, read whole: the stores are a working copy in memory.
  const loaded = new Map<string, Map<string, unknown>>();
  {
    const tx = db.transaction(ENTRIES);
    const store = tx.objectStore(ENTRIES);
    const [keys, values] = await Promise.all([
      idbRequest(store.getAllKeys()),
      idbRequest(store.getAll()),
    ]);
    keys.forEach((k, i) => {
      const [storeName, key] = k as [string, string];
      let map = loaded.get(storeName);
      if (map === undefined) loaded.set(storeName, (map = new Map()));
      map.set(key, values[i]);
    });
  }

  let closed = false;
  const pending = new Set<Promise<void>>();
  const write = (apply: (s: IDBObjectStore) => void): void => {
    if (closed) {
      throw new Error(
        `[host-storage] ${name}: a write after the storage closed — this worker no longer owns it`,
      );
    }
    const tx = db.transaction(ENTRIES, "readwrite");
    apply(tx.objectStore(ENTRIES));
    const done = idbDone(tx);
    pending.add(done);
    void done
      .finally(() => pending.delete(done))
      .catch((err: unknown) => {
        writeFailure ??= err;
        console.error(`[host-storage] ${name}: a write failed`, err);
        throw err;
      });
  };
  /** Every write so far settled; throws the first that failed. */
  let writeFailure: unknown = null;
  const flushWrites = async (): Promise<void> => {
    await Promise.allSettled([...pending]);
    if (writeFailure !== null) throw writeFailure;
  };

  const stores = new Map<string, HostStore<unknown>>();
  const resources: HostStorageResource[] = [];

  /**
   * Close everything adopted, settle the writes and close the stores, keeping
   * the lock: whoever waits on it must not open what is still being closed (or
   * deleted). Memoized, so a second close waits on the first.
   */
  let closing: Promise<void> | null = null;
  const closeKeepingLock = (): Promise<void> =>
    (closing ??= (async () => {
      closed = true;
      try {
        for (const r of resources) await r.close();
      } finally {
        await Promise.allSettled([...pending]);
        db.close();
      }
    })());
  const close = async (): Promise<void> => {
    try {
      await closeKeepingLock();
    } finally {
      ownership.release();
    }
    if (writeFailure !== null) throw writeFailure;
  };

  return {
    kind: "persistent",
    databaseDir: `idb://${prefix}db`,
    fresh,
    store<V>(storeName: string): HostStore<V> {
      let store = stores.get(storeName);
      if (store === undefined) {
        store = {
          loaded: loaded.get(storeName) ?? new Map(),
          put: (key, value) => write((s) => s.put(value, [storeName, key])),
          delete: (key) => write((s) => s.delete([storeName, key])),
        };
        stores.set(storeName, store);
      }
      return store as HostStore<V>;
    },
    adopt(resource) {
      resources.push(resource);
    },
    async booted() {
      // Durable first, then recorded: a tab closed before this point leaves
      // `seeding`, and the next open starts over.
      for (const r of resources) await r.flush();
      await flushWrites();
      await writeLifecycle({ state: "ready", migrations: [...migrations] });
      // Serving now: another build's claim may take it over from here on.
      ownership.answerClaims();
    },
    close,
    async wipe() {
      try {
        // Marked first: a wipe cut short (the tab closed) is a dead first
        // boot to the next open, which wipes again — never a `ready` record
        // over a deleted database.
        await writeLifecycle({ state: "seeding", migrations: [...migrations] });
        await closeKeepingLock();
        await deleteAll(prefix, storesName);
      } finally {
        ownership.release();
      }
    },
  };
}

/**
 * Delete every IndexedDB database of the storage (`prefix`), PGlite's
 * included — the stores (`last`, which holds the lifecycle record) last.
 */
async function deleteAll(prefix: string, last: string): Promise<void> {
  const names = (await indexedDB.databases())
    .map((d) => d.name)
    .filter((n): n is string => n !== undefined && n.includes(prefix));
  for (const n of names.filter((n) => n !== last)) await idbDelete(n);
  await idbDelete(last);
}
