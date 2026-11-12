import type { RecordsWriteLostReason } from "@plugins/plugin-meta/plugins/plugin-records/plugins/write-lost/core";

/**
 * Where records live: a content-addressed key → value map, one per kind of
 * record. A key is a hash of EVERYTHING the value is a function of (see
 * `keys.ts`), so a value never goes stale — it is simply never asked for again
 * once one of its inputs changes — and a store may be shared by every worktree
 * and every process of the machine.
 *
 * Batched on purpose: a warm build asks for ~20k records, in a handful of
 * batches, and the SQLite store answers a batch in one prepared statement.
 *
 * A read is ASYNC: answering one is I/O (a lookup of the shared store is a
 * random read of a multi-GB file, ~0.5 ms on a loaded host when its pages are
 * not cached — a check pass asks ~32k), and the process asking is often a
 * check pass, whose one JS thread every check shares. So the shared store
 * reads off that thread (`cli`'s `openRecordStore`), and a reader awaits.
 * A put is synchronous: it is held in memory until a `flush`, which writes
 * (and so may wait for the shared store's other writers) asynchronously.
 */

/** The kinds of record, one table each. */
export const RECORD_TABLES = [
  // A file's own facts (its import specifiers), keyed by its blob id.
  "file",
  // One facet's extract of one plugin, keyed by the plugin's own files.
  "facet",
  // One barrel's evaluated facts, keyed by its module Merkle key.
  "evaluated",
  // A tool's answer that only one outcome is ever stored for (drizzle-kit's
  // "no schema change"), keyed by everything the tool reads.
  "verdict",
  // The values of a set of records of one table, keyed by their keys alone
  // (`readGrouped`): one lookup for a plugin's records instead of one each.
  "group",
  // A file scan folded along the directory tree (`foldFilesCached`): a node
  // record (a file keyed by its blob, a directory by its members' keys) names
  // its value by ref, and a value record holds it, keyed by that ref.
  "fold",
] as const;
export type RecordTable = (typeof RECORD_TABLES)[number];

export interface RecordStore {
  /**
   * What every record also depends on that no file names: the runtime that
   * computes it (its version and platform). Part of every record identity, so
   * a store shared by two Bun versions keeps their records apart.
   */
  readonly environment: string;
  /** The values stored under `keys` (a key with no value is absent). */
  getMany(
    table: RecordTable,
    keys: readonly string[],
  ): Promise<Map<string, string>>;
  /** Store `entries`; a key already present keeps its value (it is the same). */
  putMany(
    table: RecordTable,
    entries: ReadonlyArray<readonly [key: string, value: string]>,
  ): void;
  /**
   * Make every record put so far visible to other processes. A store may hold
   * puts back to write them in one transaction (the SQLite store does: one
   * commit per call made a cold build's ~3.7k calls cost seconds); its own
   * reads see them at once either way. Flush where another process is about
   * to read (the build, before its checks start), and before a process that
   * put records ends.
   *
   * Never rejects for a write the store could not make: a lost record is
   * only computed again, so it is an outcome (`lost`), which the store has
   * already logged and reported — never a failure of the caller's work.
   */
  flush(): Promise<RecordFlushOutcome>;
}

/** How one write's transactions waited for, and held, the store's write lock. */
export interface RecordWriteTiming {
  transactions: number;
  /** Time spent waiting in the store's writer line, in total and the longest once. */
  waitedMs: number;
  longestWaitMs: number;
  /** Time the write lock was held, in total and the longest once. */
  heldMs: number;
  longestHoldMs: number;
}

/** What one `flush` did with the records it held. */
export type RecordFlushOutcome =
  | { kind: "written"; records: number; timing: RecordWriteTiming }
  /**
   * The store could not write them (`reason`: why): these records are not
   * stored, and are computed again by whichever pass next asks for them.
   */
  | {
      kind: "lost";
      records: number;
      reason: RecordsWriteLostReason;
      error: string;
      timing: RecordWriteTiming;
    };

/** No transaction yet. */
export function emptyWriteTiming(): RecordWriteTiming {
  return {
    transactions: 0,
    waitedMs: 0,
    longestWaitMs: 0,
    heldMs: 0,
    longestHoldMs: 0,
  };
}

/** A store that lives as long as the process: what a caller with no shared store gets. */
export function createMemoryRecordStore(environment = "memory"): RecordStore {
  const tables = new Map<RecordTable, Map<string, string>>();
  const tableOf = (t: RecordTable): Map<string, string> => {
    let m = tables.get(t);
    if (!m) tables.set(t, (m = new Map()));
    return m;
  };
  return {
    environment,
    getMany(table, keys) {
      const m = tableOf(table);
      const out = new Map<string, string>();
      for (const k of keys) {
        const v = m.get(k);
        if (v !== undefined) out.set(k, v);
      }
      return Promise.resolve(out);
    },
    putMany(table, entries) {
      const m = tableOf(table);
      for (const [k, v] of entries) if (!m.has(k)) m.set(k, v);
    },
    // Holds nothing back: every put is already where its reads look.
    flush: () =>
      Promise.resolve({
        kind: "written",
        records: 0,
        timing: emptyWriteTiming(),
      }),
  };
}

// The process's store. The build, `regen-generated` and every check pass
// install the shared one (`plugin-records/cli`) before anything reads a record;
// any other process (a script, a test) keeps the in-memory default, which
// computes everything once per process.
let installed: RecordStore | undefined;

/** Install the store every record read and write of this process goes through. */
export function installRecordStore(store: RecordStore): void {
  installed = store;
}

/** The installed store, or the process's in-memory one. */
export function currentRecordStore(): RecordStore {
  return (installed ??= createMemoryRecordStore());
}
