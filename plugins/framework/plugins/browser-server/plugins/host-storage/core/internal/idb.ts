// The few IndexedDB calls this plugin makes, as promises. Kept to what it
// needs: one object store of entries keyed by [store, key], read whole at open
// and written one transaction per change.

export function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () =>
      reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

/** Resolves when `tx` commits; rejects with its error when it aborts. */
export function idbDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () =>
      reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    tx.onerror = () => {
      // `onabort` follows with the same error.
    };
  });
}

/** Open (creating) `name` with the given object stores. */
export function idbOpen(
  name: string,
  objectStores: readonly string[],
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      for (const s of objectStores) {
        if (!req.result.objectStoreNames.contains(s))
          req.result.createObjectStore(s);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () =>
      reject(req.error ?? new Error(`IndexedDB: could not open ${name}`));
    req.onblocked = () =>
      reject(
        new Error(
          `IndexedDB: opening ${name} is blocked by an older connection that will not close`,
        ),
      );
  });
}

/**
 * Delete `name`. A delete another connection still holds is `blocked`, not
 * failed: it completes as soon as that connection closes (PGlite's filesystem
 * closes its own a moment after `close()` resolves), so this waits — loudly.
 */
export function idbDelete(name: string): Promise<void> {
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
