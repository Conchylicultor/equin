// ── Opening a browser host's storage ─────────────────────────────────────────
//
// `openHostStorage` is what a worker's entry point calls before it boots: it
// returns the storage to declare (`declareHostStorage`) plus its lifecycle —
// whether it is `fresh` (so the caller seeds it, or starts empty), `booted()`
// once the host is up on it, `close()` and `wipe()`.
//
// A persistent storage `<name>` is, in IndexedDB, laid out as `stored`'s
// `layout.ts` says (PGlite's data dir and the stores' database, holding the
// lifecycle record) — the leaf a page reads to know whether it is there.
//
// A storage may declare a starting SNAPSHOT (`./snapshot.ts`, built once by the
// build): a fresh storage then loads it — the database's data directory and
// every store's entries — instead of starting empty, each instant in it
// shifted to now. Whether stored data that started from an OLDER snapshot is
// thrown away for the new one (`whenOutdated: "reset"`) is the app's policy (a
// demo's data is throwaway; a local app's user data never is), so it is
// required wherever a snapshot is declared.
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
// - `snapshot` — the snapshot it started from. One taken LATER than this
//   code's means newer code put it there: refused the same way.
// - `owedShift` — stores loaded from the snapshot whose values are not shifted
//   to now yet: a store's owner says how its values move in time when it opens
//   it (`HostStoreOptions.shiftTime`), and one not opened on that boot owes it
//   until it is.

import {
  ENTRIES_STORE,
  LIFECYCLE_KEY,
  META_STORE,
  storagePrefix,
  storesDbName,
  type Lifecycle,
} from "@plugins/framework/plugins/browser-server/plugins/host-storage/plugins/stored/core";
import { reportDataProgress } from "@plugins/framework/plugins/browser-server/core";
import { idbDelete, idbDone, idbOpen, idbRequest } from "./idb";
import { StorageNewerThanCodeError } from "./errors";
import type {
  DatabaseStart,
  HostStoreOptions,
  HostStorage,
  HostStorageResource,
  HostStore,
} from "./host-storage";
import { memoryHostStorage } from "./host-storage";
import {
  acquireOwnership,
  type OwnerIdentity,
  type Ownership,
  type YieldReason,
} from "./ownership";
import {
  decodeHostSnapshot,
  type HostSnapshot,
  type HostSnapshotRef,
} from "./snapshot";

/**
 * A storage's starting snapshot, and what happens to stored data that started
 * from an older one.
 */
export interface HostStorageStart {
  snapshot: HostSnapshotRef;
  /**
   * Stored data from an older snapshot (or from before the storage had one):
   * `reset` — wipe it and load this one (a demo: its data is throwaway);
   * `keep` — keep it (a user's own data, never reset).
   */
  whenOutdated: "reset" | "keep";
}

/** Where an opened storage's data comes from. */
export type HostStorageOrigin =
  /** What an earlier boot left. */
  | { kind: "stored" }
  /** Nothing: no snapshot declared and nothing stored. */
  | { kind: "empty" }
  /** The declared snapshot, loaded now — `replacedOutdated` when it wiped data from an older one. */
  | { kind: "snapshot"; replacedOutdated: boolean };

export type HostStorageSpec =
  /** Lost with the worker: every open is fresh. */
  | { kind: "memory" }
  | {
      kind: "persistent";
      /** Names the storage: one per app the browser keeps (`demo-workspace`). */
      name: string;
      /** Every migration hash this code's bundle carries. */
      migrations: readonly string[];
      /** The snapshot a fresh storage starts from; absent, it starts empty. */
      start?: HostStorageStart;
      /** Which code this worker runs, and the SharedWorker name it serves under (`ownership.ts`). */
      identity: OwnerIdentity;
      /**
       * Another build — or, without SharedWorker, another tab — claimed the
       * storage from this worker (`why`): end serving — tell the tabs, answer
       * nothing more. The storage closes once it resolves.
       */
      onSuperseded: (why: YieldReason) => Promise<void>;
    };

/** An open storage, as its worker's entry point holds it. */
export interface OpenedHostStorage extends HostStorage {
  /** Where its data comes from on this boot. */
  readonly origin: HostStorageOrigin;
  /** The host booted on it (and, when fresh, filled it): record it as ready. */
  booted(): Promise<void>;
  /** Flush and close it, and everything it adopted; nothing writes after. */
  close(): Promise<void>;
  /** Close it, then delete everything it holds. */
  wipe(): Promise<void>;
}

export async function openHostStorage(
  spec: HostStorageSpec,
): Promise<OpenedHostStorage> {
  if (spec.kind === "memory") {
    return {
      ...memoryHostStorage(),
      origin: { kind: "empty" },
      booted: () => Promise.resolve(),
      close: () => Promise.resolve(),
      wipe: () => Promise.resolve(),
    };
  }
  let opened: OpenedHostStorage | null = null;
  const ownership = await acquireOwnership({
    name: spec.name,
    migrations: spec.migrations,
    snapshotTakenAt: spec.start?.snapshot.takenAt,
    identity: spec.identity,
    // Claims are answered only once the storage booted (`booted()`), so it is
    // open by then.
    onSuperseded: async (why) => {
      if (opened === null) {
        throw new Error(
          `[host-storage] ${spec.name}: superseded before it opened`,
        );
      }
      await spec.onSuperseded(why);
      await opened.close();
    },
  });
  try {
    opened = await openPersistent(
      spec.name,
      spec.migrations,
      spec.start,
      ownership,
    );
    return opened;
  } catch (err) {
    ownership.release();
    throw err;
  }
}

async function openPersistent(
  name: string,
  migrations: readonly string[],
  start: HostStorageStart | undefined,
  ownership: Ownership,
): Promise<OpenedHostStorage> {
  const prefix = storagePrefix(name);
  const storesName = storesDbName(name);
  let db = await idbOpen(storesName, [ENTRIES_STORE, META_STORE]);

  const readLifecycle = async (): Promise<Lifecycle | undefined> =>
    (await idbRequest(
      db.transaction(META_STORE).objectStore(META_STORE).get(LIFECYCLE_KEY),
    )) as Lifecycle | undefined;

  const wipeStored = async (): Promise<void> => {
    db.close();
    await deleteAll(prefix, storesName);
    db = await idbOpen(storesName, [ENTRIES_STORE, META_STORE]);
  };
  /** The snapshot `start` names, loaded and checked against this code's migrations. */
  const loadSnapshot = async (ref: HostSnapshotRef): Promise<HostSnapshot> => {
    // The pages waiting for the host see the download as it arrives.
    const snapshot = decodeHostSnapshot(await ref.load(reportDataProgress));
    const unknown = snapshot.migrations.filter((m) => !migrations.includes(m));
    const missing = migrations.filter((m) => !snapshot.migrations.includes(m));
    if (unknown.length > 0 || missing.length > 0) {
      throw new Error(
        `[host-storage] ${name}: snapshot ${ref.version.slice(0, 12)} was built at other migrations than this code's (${missing.length} missing, ${unknown.length} unknown) — the build ships a snapshot built at its own migrations, so this is a build bug`,
      );
    }
    return snapshot;
  };

  // The record as it is now; every write of it writes this whole, and moves
  // `current` before it awaits, so a later write always starts from it.
  let current!: Lifecycle;
  const writeLifecycle = async (next: Lifecycle): Promise<void> => {
    current = next;
    const tx = db.transaction(META_STORE, "readwrite");
    tx.objectStore(META_STORE).put(next, LIFECYCLE_KEY);
    await idbDone(tx);
  };

  // Every store's entries: the stores are a working copy in memory.
  const loaded = new Map<string, Map<string, unknown>>();
  let databaseStart: DatabaseStart = { from: "stored-or-empty" };
  let origin: HostStorageOrigin;
  try {
    let lifecycle = await readLifecycle();
    // Data from an older snapshot, which this app's policy replaces: what
    // its migrations were does not matter (it is thrown away), only that it
    // is older — so a migration since squashed away cannot strand it.
    const replaceable =
      lifecycle !== undefined &&
      start?.whenOutdated === "reset" &&
      lifecycle.state === "ready" &&
      lifecycle.snapshot?.version !== start.snapshot.version &&
      (lifecycle.snapshot === undefined ||
        lifecycle.snapshot.takenAt < start.snapshot.takenAt);
    if (lifecycle !== undefined && !replaceable) {
      const unknown = lifecycle.migrations.filter(
        (m) => !migrations.includes(m),
      );
      if (unknown.length > 0) {
        throw new StorageNewerThanCodeError(
          `its stored data has ${unknown.length} migration${unknown.length === 1 ? "" : "s"} this code does not know`,
        );
      }
      const stored = lifecycle.snapshot;
      if (
        start !== undefined &&
        stored !== undefined &&
        stored.takenAt > start.snapshot.takenAt
      ) {
        throw new StorageNewerThanCodeError(
          "its stored data started from a newer snapshot than this code's",
        );
      }
    }
    if (lifecycle?.state === "seeding") {
      // A first boot died mid-way: start over rather than keep half a seed.
      console.warn(
        `[host-storage] ${name}: its first boot did not finish — wiping it and starting again`,
      );
      await wipeStored();
      lifecycle = undefined;
    }
    // Loaded BEFORE anything stored is wiped for it: a snapshot that cannot
    // be fetched (offline) or does not fit this code leaves the stored data
    // as it was, and the boot fails loudly.
    const snapshot =
      start !== undefined && (lifecycle === undefined || replaceable)
        ? await loadSnapshot(start.snapshot)
        : null;
    if (replaceable) {
      console.info(
        `[host-storage] ${name}: its data started from ${lifecycle!.snapshot === undefined ? "no snapshot" : `snapshot ${lifecycle!.snapshot.version.slice(0, 12)}`} — replacing it with ${start!.snapshot.version.slice(0, 12)}`,
      );
      await wipeStored();
      lifecycle = undefined;
    }
    origin =
      lifecycle !== undefined
        ? { kind: "stored" }
        : snapshot === null
          ? { kind: "empty" }
          : { kind: "snapshot", replacedOutdated: replaceable };
    current = lifecycle ?? { state: "seeding", migrations: [...migrations] };

    if (snapshot !== null) {
      const shiftMs = Date.now() - snapshot.takenAt;
      const owedShift: Record<string, number> = {};
      // The record, marked `seeding`, and the entries, in one transaction: a
      // tab closed before `booted()` leaves `seeding`, wiped next open.
      const tx = db.transaction([ENTRIES_STORE, META_STORE], "readwrite");
      const entries = tx.objectStore(ENTRIES_STORE);
      for (const [storeName, values] of Object.entries(snapshot.stores)) {
        owedShift[storeName] = shiftMs;
        const map = new Map<string, unknown>();
        for (const [key, value] of values) {
          map.set(key, value);
          entries.put(value, [storeName, key]);
        }
        loaded.set(storeName, map);
      }
      current = {
        state: "seeding",
        migrations: [...migrations],
        snapshot: {
          version: start!.snapshot.version,
          takenAt: start!.snapshot.takenAt,
        },
        owedShift,
      };
      tx.objectStore(META_STORE).put(current, LIFECYCLE_KEY);
      await idbDone(tx);
      databaseStart = { from: "snapshot", dataDir: snapshot.database, shiftMs };
    } else {
      if (origin.kind === "empty") await writeLifecycle(current);
      const tx = db.transaction(ENTRIES_STORE);
      const store = tx.objectStore(ENTRIES_STORE);
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
  } catch (err) {
    // Nothing holds the stores' connection after a failed open: a later wipe
    // or open of it would be blocked by this one.
    db.close();
    throw err;
  }

  let closed = false;
  const pending = new Set<Promise<void>>();
  const write = (
    apply: (s: IDBObjectStore, meta: IDBObjectStore | null) => void,
    opts: { meta?: boolean } = {},
  ): void => {
    if (closed) {
      throw new Error(
        `[host-storage] ${name}: a write after the storage closed — this worker no longer owns it`,
      );
    }
    const tx = db.transaction(
      opts.meta === true ? [ENTRIES_STORE, META_STORE] : ENTRIES_STORE,
      "readwrite",
    );
    apply(
      tx.objectStore(ENTRIES_STORE),
      opts.meta === true ? tx.objectStore(META_STORE) : null,
    );
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
      // No claim is answered from here: a claimant waits for the lock.
      ownership.closing();
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
    databaseStart,
    origin,
    store<V>(storeName: string, options: HostStoreOptions<V>): HostStore<V> {
      let store = stores.get(storeName);
      if (store === undefined) {
        let values = (loaded.get(storeName) ?? new Map()) as Map<string, V>;
        const owed = current.owedShift?.[storeName];
        if (owed !== undefined) {
          // Loaded from the snapshot, not shifted yet: shift now, and record
          // it paid in the same transaction as the shifted values.
          values = new Map(
            [...values].map(([k, v]) => [k, options.shiftTime(v, owed)]),
          );
          const { [storeName]: _paid, ...stillOwed } = current.owedShift!;
          const next: Lifecycle = { ...current, owedShift: stillOwed };
          write(
            (s, meta) => {
              for (const [k, v] of values) s.put(v, [storeName, k]);
              meta!.put(next, LIFECYCLE_KEY);
            },
            { meta: true },
          );
          current = next;
        }
        store = {
          loaded: values,
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
      await writeLifecycle({
        ...current,
        state: "ready",
        migrations: [...migrations],
      });
      // Serving now: another build's claim may take it over from here on.
      ownership.answerClaims();
    },
    close,
    async wipe() {
      ownership.closing();
      try {
        // Marked first: a wipe cut short (the tab closed) is a dead first
        // boot to the next open, which wipes again — never a `ready` record
        // over a deleted database.
        await writeLifecycle({ ...current, state: "seeding" });
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
