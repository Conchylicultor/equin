import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { z } from "zod";
import {
  createThreadPool,
  serveThreadPool,
} from "@plugins/packages/plugins/thread-pool/cli";
import { RECORD_TABLES, type RecordStore, type RecordTable } from "../../core";
import { pluginRecordsDir } from "../../data-dirs";

/**
 * The shared record store: one SQLite database (WAL, so every worktree's build
 * and check pass reads and writes it at once) under the data root.
 *
 * VALUES ARE CONTENT-ADDRESSED TOO. A key is the hash of every input, the
 * producer's code included, so a change anywhere in a producer's closure
 * re-keys every record it made, while the values almost never change (measured
 * 2026-11-05: 8.7M rows held 30k distinct values, 99% byte-identical
 * duplicates). So a key row names its value by the value's own hash, and each
 * distinct value is stored once.
 *
 * Records never go stale, so the only maintenance is reclaiming the ones nobody
 * asks for any more: each key row keeps the day it was last read, refreshed at
 * most once a day, and {@link reclaimRecordStore} (main's daily
 * plugin-records.reclaim job) deletes the rows unread for {@link KEEP_DAYS},
 * then every value no row names, and returns the freed pages to the
 * filesystem.
 *
 * NO WRITE HOLDS THE STORE LONG. Every build, push and check pass on the host
 * shares this one file, and SQLite has one writer at a time: a write
 * transaction that runs long queues every other writer behind it, and one that
 * outlasts the busy timeout makes theirs throw SQLITE_BUSY (2026-11-08 and
 * 2026-11-12: aborted builds and pushes). So an open takes no write lock at
 * all, and every write goes through {@link writeBounded}: the B-tree pages a
 * write will touch are read BEFORE the lock is taken, and a transaction
 * commits once it has held the lock {@link HOLD_MS}, however many records are
 * left. The reclaim runs off every build's path, the same way.
 *
 * NO READ HOLDS THE CALLER'S THREAD. A lookup is a random read of a multi-GB
 * file: measured 2026-11-12 on a 24M-row, 8.7 GB store (5% of its rows read
 * that day, so nearly every page holds a live row and none stays cached) at
 * load ~50, ~0.5 ms each, 87% of it waiting on the disk. A check pass asks
 * ~32k of them, and its one JS thread is every check's: done in-process they
 * held it 10–15 s a pass (check-thread-stall, ~75 reports a day). So the
 * lookups run on reader threads ({@link READERS}, `bin/record-reader.ts`,
 * each with its own connection) and `getMany` awaits them; what this process
 * already read or holds answers in-process.
 */

const KEEP_DAYS = 7;
// Puts are held back until a flush: one commit per put made a cold codegen's
// ~3,700 commits cost 4.0 s on a loaded host
// (research/2026-11-06-global-build-pipeline-step7-real-world-split-v2.md).
// Past this many held bytes a put flushes on its own, so memory stays bounded.
const FLUSH_BYTES = 64 * 1024 * 1024;
// SQLite's default bound on host parameters per statement is 32766; a batch
// stays well under it.
const BATCH = 500;
// Reader threads, each with its own connection: a lookup is I/O-bound (a
// random page read), so a few in flight at once overlap their waits.
const READERS = 4;
// The longest one write transaction holds the store's lock. Bounded by TIME,
// not by a record count: what one record costs under the lock is not a
// constant. The count bound before it (2,000 records, measured 2026-11-08 at
// 1.6 s on a 600k-row store) held the lock 44–58 s on 2026-11-12 — a 23M-row,
// 8.5 GB store on a host at load ~50, where a random point lookup took 2–60 ms
// (its pages no longer in the page cache) and each insert descends three
// B-trees — so every other writer's 30 s busy wait ran out behind it.
export const HOLD_MS = 200;
// How many records one read before the lock covers (see writeBounded). Each
// such read leaves the lock free while it runs: the gap in which a writer
// waiting in SQLite's busy handler (which polls, at most 100 ms apart) takes
// it, rather than this one re-taking it at once, commit after commit.
const PROBE_BATCH = 200;
// How many key rows one reclaim step reads; the most freed pages one returns.
const RECLAIM_PAGE = 5_000;
// The first store's file (text keys, a value per row): unlinked on the daily
// reclaim, so its gigabytes go once every checkout reads this one.
const LEGACY_FILE = "records.sqlite";
const FILE = "records.v2.sqlite";
// A record key is a sha256 (`recordKey`), stored as its 32 bytes.
const KEY = /^[0-9a-f]{64}$/;

const Count = z.object({ n: z.number() });
const KeyPage = z.array(
  z.object({
    key: z.instanceof(Uint8Array),
    vid: z.instanceof(Uint8Array),
    used: z.number(),
  }),
);
const RecordRows = z.array(
  z.object({
    key: z.instanceof(Uint8Array),
    value: z.string(),
    used: z.number(),
  }),
);

// The backstop: a process that never flushed (a script, a check pass) still
// leaves its records behind. A killed one loses them, which only means they
// are computed again: every record is a pure function of its key. One exit
// listener for every store the process opened.
const openStores = new Set<() => void>();
process.on("exit", () => {
  for (const flush of openStores) flush();
});

function today(): number {
  return Math.floor(Date.now() / 86_400_000);
}

function keyBytes(key: string): Buffer {
  if (!KEY.test(key))
    throw new Error(
      `[plugin-records] ${JSON.stringify(key)} is not a record key (a recordKey sha256)`,
    );
  return Buffer.from(key, "hex");
}

/**
 * The store's database, set up. Takes no write lock on an existing store: on
 * one, each statement here is a read.
 */
function openDatabase(path: string): Database {
  const db = new Database(path, { create: true });
  // First, so every statement after it — the first open's own pragmas
  // included, when several processes create the file at once — waits for a
  // writer instead of failing.
  db.exec("PRAGMA busy_timeout = 30000");
  // Before any table exists, or it does not take: a reclaim can then return
  // its freed pages (`incremental_vacuum`) without rewriting the file. Only
  // then: setting it runs a WRITE transaction even when the file already has
  // it, so on every open it queued each reader behind whichever writer held
  // the store, and threw SQLITE_BUSY once one held it past the timeout
  // (2026-11-08: builds and pushes aborted at this line). Everything else
  // here is a read on an existing store — journal_mode = WAL once the file is
  // WAL, CREATE … IF NOT EXISTS once the schema exists — so an open never
  // waits for a writer.
  const fresh =
    Count.parse(db.query("SELECT count(*) AS n FROM sqlite_schema").get()).n ===
    0;
  if (fresh) db.exec("PRAGMA auto_vacuum = INCREMENTAL");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(
    "CREATE TABLE IF NOT EXISTS keys (tbl TEXT NOT NULL, key BLOB NOT NULL, vid BLOB NOT NULL, used INTEGER NOT NULL, PRIMARY KEY (tbl, key)) WITHOUT ROWID",
  );
  db.exec("CREATE INDEX IF NOT EXISTS keys_vid ON keys (vid)");
  db.exec(
    "CREATE TABLE IF NOT EXISTS vals (vid BLOB PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID",
  );
  return db;
}

/**
 * One write transaction, taking the write lock at its BEGIN (under the busy
 * timeout) rather than at its first write.
 */
function write(db: Database, fn: () => void): void {
  db.transaction(fn).immediate();
}

/**
 * Applies `items` in write transactions that each hold the lock at most
 * ~{@link HOLD_MS}, plus the item that crossed it — an item is one row's
 * statements, so a transaction is never left half an item. What one item
 * costs is not bounded here: a row's statements must stay small (a reclaimed
 * value's overflow pages, freed under the lock, are the largest today).
 *
 * Before each transaction, `probe` reads — with no lock, from the reader's own
 * WAL snapshot — a batch of up to {@link PROBE_BATCH} items: the very pages the
 * item's statements will descend (a point lookup of a missing key ends on the
 * leaf its insert goes into), so the locked statements find them in the page
 * cache (the OS's file cache: SQLite drops its own whenever another
 * connection commits) instead of each waiting on the disk with every other writer queued
 * behind. It returns the items still to write (a record another process stored
 * meanwhile needs no write at all). What one transaction leaves is probed
 * again with the next batch: whatever the store's size or the host's load, the
 * slow part — the reads — runs outside the lock, and the lock is free while it
 * does.
 */
export function writeBounded<T>(
  db: Database,
  items: readonly T[],
  probe: (batch: readonly T[]) => readonly T[],
  apply: (item: T) => void,
  opts?: { pace?: boolean },
): void {
  let next = 0;
  let carry: readonly T[] = [];
  while (next < items.length || carry.length > 0) {
    const take = items.slice(next, next + PROBE_BATCH - carry.length);
    next += take.length;
    const batch = probe([...carry, ...take]);
    let done = 0;
    let held = 0;
    if (batch.length > 0)
      write(db, () => {
        const start = performance.now();
        do apply(batch[done++]!);
        while (
          done < batch.length &&
          (held = performance.now() - start) < HOLD_MS
        );
        held = performance.now() - start;
      });
    carry = batch.slice(done);
    // A background writer (the reclaim) leaves the lock free as long as it
    // held it before taking it again, so a build's writer waiting in the busy
    // handler gets it even when the next probe finds its pages warm (no gap).
    if (opts?.pace && (next < items.length || carry.length > 0))
      Bun.sleepSync(held);
  }
}

function storePath(opts?: { path?: string }): string {
  return (
    opts?.path ?? (pluginRecordsDir.ensureSync(), pluginRecordsDir.file(FILE))
  );
}

export interface ReclaimResult {
  keysRead: number;
  keysDeleted: number;
  valuesDeleted: number;
  /** False on a file not created with auto_vacuum = INCREMENTAL. */
  returnsPages: boolean;
  pagesFreed: number;
}

/**
 * Deletes the key rows unread for {@link KEEP_DAYS}, every value only they
 * named, then returns the freed pages to the filesystem — never holding the
 * store long: the key rows are read a page at a time in primary-key order
 * with no lock, and each stale row and the value it alone named go in the
 * same {@link writeBounded} transaction (so an interrupted reclaim leaves no
 * value no row names). O(key rows) to read,
 * O(what it deletes) to write: a value can only lose its last name when a row
 * naming it is deleted, so no scan of the values is needed.
 */
export function reclaimRecordStore(opts?: { path?: string }): ReclaimResult {
  const db = openDatabase(storePath(opts));
  const cutoff = today() - KEEP_DAYS;
  const page = db.query(
    "SELECT key, vid, used FROM keys WHERE tbl = ? AND key > ? ORDER BY key LIMIT ?",
  );
  // Re-checked under the lock: a build may have read the row (refreshing its
  // day) since the page was read.
  const deleteKey = db.query(
    "DELETE FROM keys WHERE tbl = ? AND key = ? AND used < ?",
  );
  const deleteOrphan = db.query(
    "DELETE FROM vals WHERE vid = ? AND NOT EXISTS (SELECT 1 FROM keys WHERE keys.vid = ?)",
  );
  const valueAt = db.query("SELECT 1 FROM vals WHERE vid = ?");
  const keyNaming = db.query("SELECT 1 FROM keys WHERE vid = ? LIMIT 1");
  const result: ReclaimResult = {
    keysRead: 0,
    keysDeleted: 0,
    valuesDeleted: 0,
    returnsPages: false,
    pagesFreed: 0,
  };
  // Every table in the file, the ones no longer in RECORD_TABLES included —
  // one primary-key seek each (DISTINCT would read every row).
  const nextTable = db.query("SELECT min(tbl) AS tbl FROM keys WHERE tbl > ?");
  const tables: string[] = [];
  for (;;) {
    const { tbl } = z
      .object({ tbl: z.string().nullable() })
      .parse(nextTable.get(tables.at(-1) ?? ""));
    if (tbl === null) break;
    tables.push(tbl);
  }
  for (const tbl of tables) {
    let after: Uint8Array = new Uint8Array(0);
    for (;;) {
      const rows = KeyPage.parse(page.all(tbl, after, RECLAIM_PAGE));
      const last = rows.at(-1);
      if (last === undefined) break;
      result.keysRead += rows.length;
      after = last.key;
      // Each stale row and its value, if it named it alone, in the same
      // transaction (a row sharing the value deleted later deletes it then);
      // the value's pages read first, with no lock (its keys row was just
      // read with the page).
      writeBounded(
        db,
        rows.filter((r) => r.used < cutoff),
        (batch) => {
          for (const r of batch) {
            valueAt.get(r.vid);
            keyNaming.get(r.vid);
          }
          return batch;
        },
        (r) => {
          if (deleteKey.run(tbl, r.key, cutoff).changes === 0) return;
          result.keysDeleted++;
          result.valuesDeleted += deleteOrphan.run(r.vid, r.vid).changes;
        },
        { pace: true },
      );
    }
  }
  // Only a file created with auto_vacuum = INCREMENTAL can return its pages
  // (`openDatabase`); on any other, incremental_vacuum does nothing, so the
  // freed pages stay for SQLite to reuse.
  const freelist = (): number =>
    Count.parse(
      db.query("SELECT freelist_count AS n FROM pragma_freelist_count").get(),
    ).n;
  const mode = z
    .object({ auto_vacuum: z.number() })
    .parse(db.query("PRAGMA auto_vacuum").get()).auto_vacuum;
  result.returnsPages = mode === 2;
  if (result.returnsPages) {
    // Each step is one write transaction moving pages from the file's end
    // into the free ones — reads and writes all under the lock, so no read
    // ahead of it can help. A step is sized from the last one's measured rate
    // (timed from the lock taken, not from the wait for it) to hold the lock
    // ~HOLD_MS, growing at most twofold a step: a page's cost is not a
    // constant, and a step sized from a warm one could find its pages cold.
    // After each, the reclaim leaves the lock free as long as it held it.
    let step = 16;
    for (let free = freelist(); free > 0;) {
      let held = 0;
      write(db, () => {
        const start = performance.now();
        db.exec(`PRAGMA incremental_vacuum(${Math.min(free, step)})`);
        held = performance.now() - start;
      });
      const left = freelist();
      // A writer can take freed pages meanwhile; a step that returned
      // nothing ends it rather than looping.
      if (left >= free) break;
      const moved = free - left;
      result.pagesFreed += moved;
      step = Math.max(
        1,
        Math.min(
          RECLAIM_PAGE,
          2 * step,
          Math.floor((moved * HOLD_MS) / Math.max(held, 1)),
        ),
      );
      free = left;
      if (free > 0) Bun.sleepSync(held);
    }
  }
  // A checkout still on the code that reclaimed inside its first open of the
  // day reads this marker; stamped, it does not run that whole-store
  // transaction again today.
  db.exec(
    "CREATE TABLE IF NOT EXISTS meta (name TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID",
  );
  write(db, () =>
    db
      .query(
        "INSERT INTO meta (name, value) VALUES ('pruned', ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value",
      )
      .run(String(today())),
  );
  db.close();
  if (opts?.path === undefined)
    for (const suffix of ["", "-wal", "-shm"])
      rmSync(pluginRecordsDir.file(`${LEGACY_FILE}${suffix}`), {
        force: true,
      });
  return result;
}

/** One batch of lookups, as a reader thread is sent it. */
interface ReadRequest {
  /** The store's file. */
  path: string;
  tbl: RecordTable;
  /** At most {@link BATCH} record keys. */
  keys: string[];
  /** Today, as the asking process counts it: a row read before is refreshed. */
  day: number;
}

/**
 * The reader-thread half (`bin/record-reader.ts`): answer each batch of
 * lookups with the rows found, and refresh the found rows' last-read day — on
 * a connection of its own per store file, opened on first use.
 */
export function serveRecordReads(): void {
  const readers = new Map<string, (req: ReadRequest) => [string, string][]>();
  // Async, so a throw (a busy store, a bad row) rejects that request with its
  // own stack instead of killing the thread.
  serveThreadPool<ReadRequest, [string, string][]>(async (req) => {
    let read = readers.get(req.path);
    if (!read) readers.set(req.path, (read = recordReader(req.path)));
    return read(req);
  });
}

function recordReader(path: string): (req: ReadRequest) => [string, string][] {
  const db = openDatabase(path);
  const select = (n: number) =>
    db.query(
      `SELECT k.key AS key, v.value AS value, k.used AS used FROM keys k JOIN vals v ON v.vid = k.vid WHERE k.tbl = ? AND k.key IN (${Array(n).fill("?").join(",")})`,
    );
  const touch = db.query("UPDATE keys SET used = ? WHERE tbl = ? AND key = ?");
  return ({ tbl, keys, day }) => {
    const found: [string, string][] = [];
    const stale: Uint8Array[] = [];
    for (const row of RecordRows.parse(
      select(keys.length).all(tbl, ...keys.map(keyBytes)),
    )) {
      found.push([Buffer.from(row.key).toString("hex"), row.value]);
      if (row.used < day) stale.push(row.key);
    }
    // Refreshed right after their read, so the pages the updates touch
    // are the ones it just brought in: no read before the lock is needed.
    writeBounded(
      db,
      stale,
      (batch) => batch,
      (key) => touch.run(day, tbl, key),
    );
    return found;
  };
}

export function openRecordStore(opts?: { path?: string }): RecordStore {
  const path = storePath(opts);
  // Opened here first: a fresh file is created (and its schema made) before
  // any reader thread opens it.
  const db = openDatabase(path);
  const day = today();
  // Lazy (no thread until the first lookup) and unref-ed while idle, so it
  // never keeps the process alive.
  const readers = createThreadPool<ReadRequest, [string, string][]>({
    url: new URL("../../bin/record-reader.ts", import.meta.url),
    size: READERS,
    name: "plugin-records-reader",
  });

  const tableId = (t: RecordTable): RecordTable => {
    if (!RECORD_TABLES.includes(t))
      throw new Error(`[plugin-records] unknown record table ${t}`);
    return t;
  };
  // The reads before the lock (writeBounded's probe): each ends on the page
  // its write goes into.
  const keyAt = db.query("SELECT 1 FROM keys WHERE tbl = ? AND key = ?");
  const valueAt = db.query("SELECT 1 FROM vals WHERE vid = ?");
  const keyNaming = db.query("SELECT 1 FROM keys WHERE vid = ? LIMIT 1");
  const insertValue = db.query(
    "INSERT INTO vals (vid, value) VALUES (?, ?) ON CONFLICT (vid) DO NOTHING",
  );
  const insertKey = db.query(
    "INSERT INTO keys (tbl, key, vid, used) VALUES (?, ?, ?, ?) ON CONFLICT (tbl, key) DO NOTHING",
  );

  // What `putMany` has held back, per table, until the next `flush`.
  const pending = new Map<RecordTable, Map<string, string>>();
  let pendingBytes = 0;
  // Every record this process has read, per table. A record is a pure
  // function of its key, so a key this process already read is never asked of
  // SQLite again: a build reads the same facts from several readers (the facet
  // records for the barrel-free and then the enriched tree, a scan's files
  // from two generators, each module graph's file facts), and each would
  // otherwise be another B-tree lookup in a ~1 GB file (~37k repeated keys in
  // a no-change build). Not a fingerprint — the key IS the value's identity.
  // Bounded by what one process reads; what it writes is held only until the
  // flush, as before.
  const known = new Map<RecordTable, Map<string, string>>();
  const knownOf = (tbl: RecordTable): Map<string, string> => {
    let m = known.get(tbl);
    if (!m) known.set(tbl, (m = new Map()));
    return m;
  };
  // The reads on their way, per table and key: a key another caller is
  // already reading joins that read rather than asking again.
  const inFlight = new Map<RecordTable, Map<string, Promise<void>>>();
  const inFlightOf = (tbl: RecordTable): Map<string, Promise<void>> => {
    let m = inFlight.get(tbl);
    if (!m) inFlight.set(tbl, (m = new Map()));
    return m;
  };
  const flush = (): void => {
    if (pending.size === 0) return;
    const rows: {
      tbl: RecordTable;
      key: Buffer;
      vid: Buffer;
      value: string;
    }[] = [];
    for (const [tbl, held] of pending)
      for (const [k, value] of held)
        rows.push({
          tbl,
          key: keyBytes(k),
          vid: new Bun.CryptoHasher("sha256").update(value).digest(),
          value,
        });
    writeBounded(
      db,
      rows,
      // A key already stored (by another build that computed the same
      // record) is dropped: its value is the same. The value is still
      // inserted with each new key, never skipped on a read: the reclaim may
      // delete an unnamed value between this read and the write.
      (batch) =>
        batch.filter((r) => {
          if (keyAt.get(r.tbl, r.key) !== null) return false;
          valueAt.get(r.vid);
          keyNaming.get(r.vid);
          return true;
        }),
      (r) => {
        insertValue.run(r.vid, r.value);
        insertKey.run(r.tbl, r.key, r.vid, day);
      },
    );
    pending.clear();
    pendingBytes = 0;
  };
  openStores.add(flush);

  return {
    environment: `bun ${Bun.version} ${process.platform}-${process.arch}`,
    async getMany(table, keys) {
      const tbl = tableId(table);
      const out = new Map<string, string>();
      // A record put but not yet flushed answers from where it is held, one
      // this process already read or wrote from what it knows, one another
      // caller is reading from that read.
      const held = pending.get(tbl);
      const seen = knownOf(tbl);
      const flying = inFlightOf(tbl);
      const joined = new Set<Promise<void>>();
      const ask: string[] = [];
      for (const k of keys) {
        const v = held?.get(k) ?? seen.get(k);
        if (v !== undefined) out.set(k, v);
        else {
          const f = flying.get(k);
          if (f) joined.add(f);
          else ask.push(k);
        }
      }
      for (let i = 0; i < ask.length; i += BATCH) {
        const chunk = ask.slice(i, i + BATCH);
        const read = readers
          .run({ path, tbl, keys: chunk, day })
          .then((rows) => {
            for (const [k, v] of rows) seen.set(k, v);
          })
          .finally(() => {
            for (const k of chunk) flying.delete(k);
          });
        for (const k of chunk) flying.set(k, read);
        joined.add(read);
      }
      if (joined.size === 0) return out;
      // Every read this call waited for left what it found in `seen`.
      await Promise.all(joined);
      for (const k of keys)
        if (!out.has(k)) {
          const v = seen.get(k);
          if (v !== undefined) out.set(k, v);
        }
      return out;
    },
    putMany(table, entries) {
      const tbl = tableId(table);
      let held = pending.get(tbl);
      if (!held) pending.set(tbl, (held = new Map()));
      for (const [k, v] of entries) {
        keyBytes(k); // a bad key fails at its put, not at a later flush
        if (held.has(k)) continue;
        held.set(k, v);
        pendingBytes += v.length;
      }
      if (pendingBytes >= FLUSH_BYTES) flush();
    },
    flush,
  };
}
