// The IndexedDB layout of a persistent browser host's storage `<name>` — read
// by `host-storage`'s open (which writes it) and by `hostDataStored` (which
// only asks whether it is there):
// - `equin-host--<name>--db` — PGlite's data dir (`idb://…`);
// - `equin-host--<name>--stores` — the host stores' entries, keyed
//   [store, key], and the lifecycle record (`meta`/`lifecycle`).

/** Every IndexedDB database of storage `name` starts with this. */
export const storagePrefix = (name: string): string => `equin-host--${name}--`;

/** The database holding the stores' entries and the lifecycle record. */
export const storesDbName = (name: string): string =>
  `${storagePrefix(name)}stores`;

/** The object store of the stores' entries, keyed [store, key]. */
export const ENTRIES_STORE = "entries";
/** The object store holding the lifecycle record. */
export const META_STORE = "meta";
/** The lifecycle record's key in {@link META_STORE}. */
export const LIFECYCLE_KEY = "lifecycle";

/** What a storage's data is (`host-storage`'s open owns its meaning). */
export interface Lifecycle {
  state: "seeding" | "ready";
  migrations: string[];
  snapshot?: { version: string; takenAt: number };
  /** Per store, the ms its snapshot-loaded values still owe a shift to now. */
  owedShift?: Record<string, number>;
}
