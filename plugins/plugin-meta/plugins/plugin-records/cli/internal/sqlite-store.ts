import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { z } from "zod";
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
 * outlasts the busy timeout makes theirs throw SQLITE_BUSY (2026-11-08: a
 * day of aborted builds and pushes). So an open takes no write lock at all, a
 * write commits at most {@link WRITE_CHUNK} records per transaction, and the
 * reclaim runs off every build's path, a page at a time.
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
// The most records one write transaction holds the store for. A flush was ONE
// transaction of up to 64 MB, and every other writer on the host waited it
// out. Measured 2026-11-08 (a 600k-row store, 30k records / 59 MB flushed,
// loaded host): one transaction held the lock 10.0 s; chunks of 2,000 held it
// at most 1.6 s for the same total time (6.4 s). The price is WAL volume —
// 371 MB written against 133 MB, as each commit rewrites leaves the last one
// touched — which checkpoints reclaim between commits, where a single
// transaction's frames all stay in the WAL until it ends. 500 held no less
// (1.6 s, 418 MB); 5,000 held 4.3 s.
const WRITE_CHUNK = 2_000;
// How many key rows (or freed pages) one reclaim step reads (or returns).
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

function storePath(opts?: { path?: string }): string {
  return opts?.path ?? (pluginRecordsDir.ensure(), pluginRecordsDir.file(FILE));
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
 * named, then returns the freed pages to the filesystem — a page at a time,
 * so the store is never held for more than one page's deletes: the key rows
 * are read in primary-key order with no lock, and each page's stale rows and
 * the values they alone named go in one short write transaction (so an
 * interrupted reclaim leaves no value no row names). O(key rows) to read,
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
      const stale = rows.filter((r) => r.used < cutoff);
      for (let i = 0; i < stale.length; i += WRITE_CHUNK) {
        const chunk = stale.slice(i, i + WRITE_CHUNK);
        write(db, () => {
          const vids = new Map<string, Uint8Array>();
          for (const r of chunk) {
            if (deleteKey.run(tbl, r.key, cutoff).changes === 0) continue;
            result.keysDeleted++;
            vids.set(Buffer.from(r.vid).toString("hex"), r.vid);
          }
          for (const vid of vids.values())
            result.valuesDeleted += deleteOrphan.run(vid, vid).changes;
        });
      }
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
    for (let free = freelist(); free > 0;) {
      db.exec(`PRAGMA incremental_vacuum(${Math.min(free, RECLAIM_PAGE)})`);
      const left = freelist();
      // A writer can take freed pages meanwhile; a step that returned
      // nothing ends it rather than looping.
      if (left >= free) break;
      result.pagesFreed += free - left;
      free = left;
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

export function openRecordStore(opts?: { path?: string }): RecordStore {
  const db = openDatabase(storePath(opts));
  const day = today();

  const tableId = (t: RecordTable): RecordTable => {
    if (!RECORD_TABLES.includes(t))
      throw new Error(`[plugin-records] unknown record table ${t}`);
    return t;
  };
  const select = (n: number) =>
    db.query(
      `SELECT k.key AS key, v.value AS value, k.used AS used FROM keys k JOIN vals v ON v.vid = k.vid WHERE k.tbl = ? AND k.key IN (${Array(n).fill("?").join(",")})`,
    );
  const touch = (n: number) =>
    db.query(
      `UPDATE keys SET used = ? WHERE tbl = ? AND key IN (${Array(n).fill("?").join(",")})`,
    );
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
  const flush = (): void => {
    if (pending.size === 0) return;
    let chunk: [RecordTable, string, string][] = [];
    const commit = (): void => {
      const rows = chunk;
      chunk = [];
      write(db, () => {
        for (const [tbl, k, v] of rows) {
          const vid = new Bun.CryptoHasher("sha256").update(v).digest();
          insertValue.run(vid, v);
          insertKey.run(tbl, keyBytes(k), vid, day);
        }
      });
    };
    for (const [tbl, held] of pending) {
      for (const [k, v] of held) {
        chunk.push([tbl, k, v]);
        if (chunk.length === WRITE_CHUNK) commit();
      }
    }
    if (chunk.length > 0) commit();
    pending.clear();
    pendingBytes = 0;
  };
  openStores.add(flush);

  return {
    environment: `bun ${Bun.version} ${process.platform}-${process.arch}`,
    getMany(table, keys) {
      const tbl = tableId(table);
      const out = new Map<string, string>();
      // A record put but not yet flushed answers from where it is held, one
      // this process already read or wrote from what it knows.
      const held = pending.get(tbl);
      const seen = knownOf(tbl);
      const unheld: string[] = [];
      for (const k of keys) {
        const v = held?.get(k) ?? seen.get(k);
        if (v === undefined) unheld.push(k);
        else out.set(k, v);
      }
      const stale: Buffer[] = [];
      for (let i = 0; i < unheld.length; i += BATCH) {
        const chunk = unheld.slice(i, i + BATCH).map(keyBytes);
        for (const row of RecordRows.parse(
          select(chunk.length).all(tbl, ...chunk),
        )) {
          const key = Buffer.from(row.key).toString("hex");
          out.set(key, row.value);
          seen.set(key, row.value);
          if (row.used < day) stale.push(Buffer.from(row.key));
        }
      }
      for (let i = 0; i < stale.length; i += WRITE_CHUNK) {
        const chunk = stale.slice(i, i + WRITE_CHUNK);
        write(db, () => {
          for (let j = 0; j < chunk.length; j += BATCH) {
            const part = chunk.slice(j, j + BATCH);
            touch(part.length).run(day, tbl, ...part);
          }
        });
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
