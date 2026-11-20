// Deleting a persistent host's storage: the databases `layout.ts` names, the
// stores' last — they hold the lifecycle record, the one fact that says what
// the rest is. Used by `host-storage`'s own wipe (Reset, a dead first boot,
// outdated data) inside its worker, and by `wipeHostData` from a page that
// has no running host to ask (a demo whose boot failed).

import {
  LIFECYCLE_KEY,
  META_STORE,
  storagePrefix,
  storageLockName,
  storesDbName,
  type Lifecycle,
} from "./layout";

/**
 * Delete `name`. A delete another connection still holds is `blocked`, not
 * failed: it completes as soon as that connection closes (PGlite's filesystem
 * closes its own a moment after `close()` resolves), so this waits — loudly.
 */
function idbDelete(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () =>
      reject(req.error ?? new Error(`IndexedDB: could not delete ${name}`));
    req.onblocked = () =>
      console.warn(
        `[host-storage] deleting ${name} waits for a connection still open on it`,
      );
  });
}

/**
 * Delete every IndexedDB database of storage `name`, PGlite's included — the
 * stores (which hold the lifecycle record) last. The caller holds the
 * storage's lock and has marked the record `seeding` first, so a delete cut
 * short (the tab closed) reads as a dead first boot to the next open, which
 * wipes again — never a `ready` record over a deleted database.
 */
export async function deleteStorageDatabases(name: string): Promise<void> {
  const prefix = storagePrefix(name);
  const last = storesDbName(name);
  const names =
    typeof indexedDB.databases === "function"
      ? (await indexedDB.databases())
          .map((d) => d.name)
          .filter((n): n is string => n !== undefined && n.includes(prefix))
      : // No listing below Firefox 126 (the browser floor is 115): delete the
        // names the storage has — PGlite's IDBFS database for its
        // `idb://${prefix}db` data dir, and the stores. Emscripten's IDBFS
        // names its database by the mount point (`getDB(mount.mountpoint)`),
        // and PGlite mounts `idb://<dir>` at `/pglite/<dir>` (its IdbFs
        // `init`, as of @electric-sql/pglite 0.5.12).
        [`/pglite/${prefix}db`, last];
  for (const n of names.filter((n) => n !== last)) await idbDelete(n);
  await idbDelete(last);
}

/**
 * Mark storage `name`'s lifecycle record `seeding`, when there is one — never
 * creating the stores' database where it is absent (an open that would
 * upgrade is aborted, as `hostDataStored` does).
 */
async function markSeeding(name: string): Promise<void> {
  const dbName = storesDbName(name);
  const db = await new Promise<IDBDatabase | null>((resolve, reject) => {
    const req = indexedDB.open(dbName);
    let absent = false;
    req.onupgradeneeded = () => {
      absent = true;
      req.transaction!.abort();
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      if (absent) resolve(null);
      else
        reject(req.error ?? new Error(`IndexedDB: could not open ${dbName}`));
    };
  });
  if (db === null) return;
  try {
    if (!db.objectStoreNames.contains(META_STORE)) return;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(META_STORE, "readwrite");
      const store = tx.objectStore(META_STORE);
      const req = store.get(LIFECYCLE_KEY);
      req.onsuccess = () => {
        const lifecycle = req.result as Lifecycle | undefined;
        if (lifecycle !== undefined)
          store.put({ ...lifecycle, state: "seeding" }, LIFECYCLE_KEY);
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () =>
        reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    });
  } finally {
    db.close();
  }
}

/**
 * Throw away everything this browser keeps for storage `name`, from a page —
 * so the next host starts from its snapshot (or empty), as after a Reset.
 * Reset asks the running host to wipe its own storage; this is the way out
 * when no host runs to ask: a host whose boot failed on what it stored
 * would fail on it again on every retry.
 *
 * Taken under the storage's lock (`storageLockName`) in `locks` — the page's
 * lock manager (`web-locks`' `webLocks()`; a page without one cannot keep a
 * host off the data, so it has no wipe to offer) — so it never deletes under
 * a host that has it open: a failed host released it (or its worker retired,
 * which does), and a healthy one serving another tab keeps it — this then
 * waits for it, as a new worker would. No timeout: the lock ends with its
 * holder however it ends.
 */
export async function wipeHostData(
  locks: LockManager,
  name: string,
): Promise<void> {
  await locks.request(storageLockName(name), async () => {
    await markSeeding(name);
    await deleteStorageDatabases(name);
  });
}
