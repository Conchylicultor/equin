// The watchdog's durable stall records, in IndexedDB — the one store a
// SharedWorker can write that outlives it (the worker dies with the last tab of
// the origin, or with the browser). Written at most a handful of times per
// stall (stall-machine's persist / forget effects), never while idle. Worker-
// safe: raw IndexedDB, no imports from other plugins.

import type { StallRecord } from "./stall-machine";

const STORE = "stalls";

export interface StallStore {
  put(record: StallRecord): Promise<void>;
  delete(id: string): Promise<void>;
  get(id: string): Promise<StallRecord | undefined>;
  all(): Promise<StallRecord[]>;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () =>
      reject(req.error ?? new Error("IndexedDB: request failed"));
  });
}

export async function openStallStore(
  idb: IDBFactory,
  dbName: string,
): Promise<StallStore> {
  const open = idb.open(dbName, 1);
  open.onupgradeneeded = () => {
    open.result.createObjectStore(STORE, { keyPath: "id" });
  };
  const db = await request(open);
  const run = <T>(
    mode: IDBTransactionMode,
    fn: (s: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> => request(fn(db.transaction(STORE, mode).objectStore(STORE)));
  return {
    put: async (record) => {
      await run("readwrite", (s) => s.put(record));
    },
    delete: async (id) => {
      await run("readwrite", (s) => s.delete(id));
    },
    get: (id) =>
      run("readonly", (s) => s.get(id) as IDBRequest<StallRecord | undefined>),
    all: () => run("readonly", (s) => s.getAll() as IDBRequest<StallRecord[]>),
  };
}
