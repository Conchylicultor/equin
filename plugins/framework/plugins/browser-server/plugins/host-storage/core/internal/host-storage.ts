// ── Where a browser host keeps its state ─────────────────────────────────────
//
// A browser host holds state in its database (PGlite) and in a few host stores
// that live in memory (config, transcripts, attachment bytes, data files). This
// module is the one answer to "does that state outlive the worker, and where":
// the worker's entry point opens a storage (`openHostStorage`, `./open.ts`) and
// declares it here before it boots the graph; the providers read it lazily
// (`hostStorage()`), never at module evaluation. Like the runtime namespace
// (`infra/runtime-identity`), it is a fact handed to the process at its entry,
// so reading it before anyone declared it throws instead of guessing.
//
// Design: the wiki page "Design: a browser host's data kept in browser storage"
// (under the track "apps running in the browser").

/**
 * One named store of a host's state outside its database: what it held when
 * the storage opened, and the writes that keep it current. A store keeps its
 * own working copy in memory and writes every change through, in order; the
 * storage persists them (or, in memory, drops them). Values are plain data
 * and bytes (`Uint8Array`) — never a `Blob` (`BlobFree`).
 */
export interface HostStore<V> {
  /** Everything this store held when the storage opened, by key. */
  readonly loaded: ReadonlyMap<string, V>;
  put(key: string, value: V): void;
  delete(key: string): void;
}

/**
 * `true` when a `Blob` sits anywhere in `V` (any member of a union). A host
 * store refuses such a value at compile time (`BlobFree`): WebKit's IndexedDB
 * cannot store a Blob from a worker ("Error preparing Blob/File data to be
 * stored in object store") nor reliably read one back, so bytes are kept as a
 * `Uint8Array` and a Blob is made from them when read.
 */
export type HoldsBlob<V, Depth extends unknown[] = []> = V extends Blob
  ? true
  : V extends ArrayBufferView
    ? false
    : // Recursive data (a JSON document) is looked into only so deep: below
      // that, `assertStoreValue` refuses it at runtime.
      Depth["length"] extends 6
      ? false
      : V extends object
        ? true extends {
            [K in keyof V]-?: HoldsBlob<V[K], [...Depth, unknown]>;
          }[keyof V]
          ? true
          : false
        : false;

/** `store`'s trailing check: nothing to pass, unless `V` holds a Blob. */
export type BlobFree<V> =
  true extends HoldsBlob<V>
    ? [error: "a host store value holds a Blob: keep bytes as a Uint8Array"]
    : [];

/**
 * Throws when `value` holds a `Blob` anywhere (`path` names where): the
 * runtime half of `BlobFree`, for a value typed loosely on its way in. A
 * Blob stores fine in Chromium and fails only on WebKit, so it is refused on
 * every engine.
 */
export function assertStoreValue(value: unknown, path: string): void {
  if (value === null || typeof value !== "object") return;
  if (value instanceof Blob) {
    throw new Error(
      `[host-storage] ${path} is a Blob: a host store keeps bytes as a Uint8Array — WebKit's IndexedDB cannot store a Blob`,
    );
  }
  if (ArrayBuffer.isView(value)) return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertStoreValue(v, `${path}[${i}]`));
    return;
  }
  for (const [k, v] of Object.entries(value))
    assertStoreValue(v, `${path}.${k}`);
}

/**
 * How a store's values move in time, declared by the store's owner: when a
 * storage starts from a snapshot taken earlier (`./snapshot.ts`), every value
 * it loads is shifted by `ms` (now − when the snapshot was taken), so an
 * instant it holds reads as long ago as it did then. Required: only the owner
 * knows which of its fields are instants (`(v) => v` when none is).
 */
export interface HostStoreOptions<V> {
  shiftTime: (value: V, ms: number) => V;
}

/**
 * What the database opens with: nothing (it starts empty, or with what the
 * storage already holds), a snapshot's data directory to load — every
 * instant in it shifted by `shiftMs` before anything reads it — or an
 * initialized, empty cluster (initdb's output for this PGlite build, no app
 * state in it), so a fresh database opens without running initdb.
 */
export type DatabaseStart =
  | { from: "stored-or-empty" }
  | { from: "snapshot"; dataDir: Blob; shiftMs: number }
  | { from: "initialized"; dataDir: Blob };

/** Something the storage closes with it — the database, which it does not own. */
export interface HostStorageResource {
  /** Make every write so far durable. */
  flush(): Promise<void>;
  /** Flush, then release it: nothing may use it after. */
  close(): Promise<void>;
  /** Its whole content, as a snapshot carries it (PGlite's data directory). */
  dump(): Promise<Blob>;
}

/** A browser host's storage, as the providers read it. */
export interface HostStorage {
  /** `memory`: lost with the worker. `persistent`: IndexedDB, under `name`. */
  readonly kind: "memory" | "persistent";
  /** The PGlite `dataDir` the database opens: `undefined` is in memory. */
  readonly databaseDir: string | undefined;
  /** What the database opens with: what it holds, or a snapshot to load. */
  readonly databaseStart: DatabaseStart;
  /** The named store (one instance per name). */
  store<V>(
    name: string,
    options: HostStoreOptions<V>,
    ...blobFree: BlobFree<V>
  ): HostStore<V>;
  /** Close `resource` with the storage (before it is wiped or handed to another worker). */
  adopt(resource: HostStorageResource): void;
}

let declared: HostStorage | undefined;

/**
 * State where this browser host keeps its state. Called ONCE, by the worker's
 * entry point, before the graph boots. A second declaration throws: two
 * storages in one host would split its state between them.
 */
export function declareHostStorage(storage: HostStorage): void {
  if (declared !== undefined && declared !== storage) {
    throw new Error(
      "[host-storage] this browser host already declared its storage — a host keeps its state in exactly one.",
    );
  }
  declared = storage;
}

/** The storage this browser host declared; throws when none was. */
export function hostStorage(): HostStorage {
  if (declared === undefined) {
    throw new Error(
      "[host-storage] read before any storage was declared — a browser host's entry point declares one (declareHostStorage) before it boots the graph, and a test declares memoryHostStorage().",
    );
  }
  return declared;
}

const noWrites = new Map<string, never>();

// Its writes go nowhere, but are checked as a persistent store checks them: a
// Blob refused in a test, not first on a visitor's WebKit.
const noStore: HostStore<unknown> = {
  loaded: noWrites,
  put: (key, value) => assertStoreValue(value, key),
  delete() {},
};

// Stateless, so one instance serves every caller: a test process that boots
// several graphs declares the same storage each time.
const MEMORY: HostStorage = {
  kind: "memory",
  databaseDir: undefined,
  databaseStart: { from: "stored-or-empty" },
  store: <V>() => noStore as HostStore<V>,
  adopt() {},
};

/**
 * State held in memory only: every store opens empty and its writes go nowhere
 * past the store's own working copy; the database is in memory. What a test
 * and an ephemeral host use.
 */
export function memoryHostStorage(): HostStorage {
  return MEMORY;
}
