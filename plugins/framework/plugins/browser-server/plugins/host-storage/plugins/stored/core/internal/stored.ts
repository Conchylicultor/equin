import {
  LIFECYCLE_KEY,
  META_STORE,
  storesDbName,
  type Lifecycle,
} from "./layout";

/**
 * Whether this browser holds storage `name`'s data, booted at least once
 * (its lifecycle record says `ready`) — so starting its host downloads no
 * starting data. Read without booting anything and without creating the
 * database when it is absent (`indexedDB.databases()` first where there is
 * one; else an open that aborts its own creation), so a page can
 * ask before it decides to start the host: a demo's gate.
 *
 * `false` where the page has no IndexedDB at all: nothing can be stored
 * there. Whether that stored data is still current (a newer build's snapshot
 * replaces it) is the host's to decide when it opens it.
 */
export async function hostDataStored(name: string): Promise<boolean> {
  if (typeof indexedDB === "undefined") return false;
  const dbName = storesDbName(name);
  // A cheap no where the browser lists its databases (Firefox 126+, so not
  // on the whole floor); the open below answers absence on its own.
  if (typeof indexedDB.databases === "function") {
    const existing = await indexedDB.databases();
    if (!existing.some((db) => db.name === dbName)) return false;
  }
  const db = await new Promise<IDBDatabase | null>((resolve, reject) => {
    // No version: an existing database opens as it is, never upgraded.
    const req = indexedDB.open(dbName);
    let absent = false;
    // An upgrade here means the database is not there: never created, or
    // gone between `databases()` and this open (a wipe). Created now, it
    // would be an empty version 1 without the host's object stores, which the host's own open
    // (at version 1) would then never upgrade — so the creation is aborted.
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
  if (db === null) return false;
  try {
    if (!db.objectStoreNames.contains(META_STORE)) return false;
    const lifecycle = await new Promise<Lifecycle | undefined>(
      (resolve, reject) => {
        const req = db
          .transaction(META_STORE, "readonly")
          .objectStore(META_STORE)
          .get(LIFECYCLE_KEY);
        req.onsuccess = () => resolve(req.result as Lifecycle | undefined);
        req.onerror = () =>
          reject(req.error ?? new Error("IndexedDB request failed"));
      },
    );
    return lifecycle?.state === "ready";
  } finally {
    db.close();
  }
}
