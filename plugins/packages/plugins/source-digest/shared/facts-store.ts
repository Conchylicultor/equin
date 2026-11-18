import { Database, type Statement } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFile } from "@plugins/packages/plugins/timed-fs/core";
import { z } from "zod";
import { sourceFactsDir } from "../data-dirs";

// The closure walk's per-file facts, kept across processes.
//
// A repo file's facts — the sha256 of its bytes and the import specifiers
// Bun's scan reads from them — are a function of its bytes and of the scanner
// (this Bun, this module's code). The walk reads them under the file's stamp
// (`ino:size:ctime`), and a file keeps its stamp exactly as long as it keeps
// its bytes (`stampOf` in digest.ts). So facts recorded under a stamp are the
// facts of whatever file holds that stamp, in any process: a walk that finds
// the file's present stamp here reads nothing.
//
// Every backend boot used to read and scan its closure anew — the boot
// digests (~0.6 s CPU before ready) and restart-skip's adoption walk (~0.6 s
// CPU while the tabs resubscribe) — although nothing in it had changed since
// the last boot. Now a boot reads only the files written since any process
// last read them: O(closure) stats, O(changed files) reads. A cold host (an
// empty store, a new Bun, a change to the scanner) pays the full read once.
//
// One row per (scanner, path): the stamp it was read under, its sha256 and
// imports. A row whose stamp is not the file's present one is simply not used
// (and replaced by the next read). Rows unread for KEEP_DAYS are dropped — a
// removed worktree's files, a retired scanner — by `pruneSourceFacts`, which
// the daily source-digest.prune job runs (main only). It used to run inside
// the first open of each UTC day: one DELETE scanning the whole table (2.8M
// rows, 1.4 GB, no index on `used`), so every process opening the store just
// after midnight raced for that write and the losers threw "database is
// locked" past their busy timeout — a build's verdict depended on the time of
// day (2026-11-18).

const KEEP_DAYS = 14;

/** What a file's bytes say, as the walk records it. */
export interface StoredFacts {
  sha256: string;
  imports: readonly string[];
}

const Row = z.object({
  stamp: z.string(),
  sha256: z.string(),
  imports: z.string(),
  used: z.number(),
});

function today(): number {
  return Math.floor(Date.now() / 86_400_000);
}

interface Open {
  db: Database;
  scanner: string;
  get: Statement;
  put: Statement;
  touch: Statement;
}

/**
 * The scanner's identity: this Bun (its transpiler does the scan) and the
 * bytes of the module whose code turns a file into facts (digest.ts). Read
 * from the module's own file, so a change to it re-reads every file once —
 * no version to bump.
 */
async function scannerOf(scannerModule: string): Promise<string> {
  const bytes = await readFile(scannerModule);
  return createHash("sha256")
    .update(`${Bun.revision}\n`)
    .update(bytes)
    .digest("hex")
    .slice(0, 32);
}

let opened: Promise<Open> | null = null;
const pending = new Map<string, { stamp: string; facts: StoredFacts }>();
const touched = new Set<string>();
let flushQueued = false;

/**
 * The host's facts database, its schema made. Every write on it is one short
 * transaction (a walk batch's new rows, or one page of the prune's deletes): a
 * writer waits only for another process's equally short one.
 */
async function openFactsDb(path?: string): Promise<Database> {
  const file = path ?? `${await sourceFactsDir.ensure()}/facts.sqlite`;
  const db = new Database(file, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(
    "CREATE TABLE IF NOT EXISTS facts (scanner TEXT NOT NULL, path TEXT NOT NULL, stamp TEXT NOT NULL, sha256 TEXT NOT NULL, imports TEXT NOT NULL, used INTEGER NOT NULL, PRIMARY KEY (scanner, path)) WITHOUT ROWID",
  );
  db.exec(
    "CREATE TABLE IF NOT EXISTS meta (name TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID",
  );
  return db;
}

function open(scannerModule: string): Promise<Open> {
  opened ??= (async () => {
    const scanner = await scannerOf(scannerModule);
    // No maintenance here: the prune is the daily source-digest.prune job's
    // (`pruneSourceFacts`), off every reader's path.
    const db = await openFactsDb();
    return {
      db,
      scanner,
      get: db.query(
        "SELECT stamp, sha256, imports, used FROM facts WHERE scanner = ? AND path = ?",
      ),
      put: db.query(
        "INSERT INTO facts (scanner, path, stamp, sha256, imports, used) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (scanner, path) DO UPDATE SET stamp = excluded.stamp, sha256 = excluded.sha256, imports = excluded.imports, used = excluded.used",
      ),
      touch: db.query(
        "UPDATE facts SET used = ? WHERE scanner = ? AND path = ?",
      ),
    };
  })();
  return opened;
}

/**
 * The facts recorded for `path` under `stamp` by any process, or `null` when
 * none were (never read, or read under another stamp).
 */
export async function storedFacts(
  scannerModule: string,
  path: string,
  stamp: string,
): Promise<StoredFacts | null> {
  const held = pending.get(path);
  if (held !== undefined && held.stamp === stamp) return held.facts;
  const store = await open(scannerModule);
  const row = Row.nullable().parse(store.get.get(store.scanner, path));
  if (row === null || row.stamp !== stamp) return null;
  if (row.used < today()) {
    touched.add(path);
    queueFlush(store);
  }
  return {
    sha256: row.sha256,
    imports: z.array(z.string()).parse(JSON.parse(row.imports)),
  };
}

/** Record `path`'s facts under the stamp its bytes held throughout the read. */
export async function storeFacts(
  scannerModule: string,
  path: string,
  stamp: string,
  facts: StoredFacts,
): Promise<void> {
  pending.set(path, { stamp, facts });
  queueFlush(await open(scannerModule));
}

// The rows of one walk batch are written together, in one transaction, once
// the batch's reads have landed (a macrotask later): a cold walk of a
// backend's closure is ~5.7k rows, not ~5.7k commits.
function queueFlush(store: Open): void {
  if (flushQueued) return;
  flushQueued = true;
  setImmediate(() => {
    flushQueued = false;
    const rows = [...pending];
    const uses = [...touched];
    pending.clear();
    touched.clear();
    const day = today();
    store.db.transaction(() => {
      for (const [path, { stamp, facts }] of rows) {
        store.put.run(
          store.scanner,
          path,
          stamp,
          facts.sha256,
          JSON.stringify(facts.imports),
          day,
        );
      }
      for (const path of uses) store.touch.run(day, store.scanner, path);
    })();
  });
}

/** Rows the prune reads per page, and deletes per transaction at most. */
const PRUNE_PAGE = 1000;

export interface PruneResult {
  rowsRead: number;
  rowsDeleted: number;
  /** Write transactions taken, and the longest one held the lock. */
  transactions: number;
  longestHoldMs: number;
}

const KeyPage = z.array(
  z.object({ scanner: z.string(), path: z.string(), used: z.number() }),
);

/**
 * Deletes the rows unread for {@link KEEP_DAYS} without ever holding the store
 * long: the rows are read a page at a time in primary-key order (a WAL read,
 * no lock), and only a page's stale rows are deleted, in one short
 * transaction each, re-checked under the lock (a walk may have read or
 * rewritten the row since). O(rows) to read, O(what it deletes) to write.
 *
 * Then stamps the old daily marker, so a checkout still on the code that
 * pruned inside its first open of the day does not run that whole-table
 * DELETE again today.
 */
export async function pruneSourceFacts(opts?: {
  path?: string;
  /** Today, as a day number (tests). */
  day?: number;
}): Promise<PruneResult> {
  const db = await openFactsDb(opts?.path);
  const day = opts?.day ?? today();
  const cutoff = day - KEEP_DAYS;
  const page = db.query(
    "SELECT scanner, path, used FROM facts WHERE (scanner, path) > (?, ?) ORDER BY scanner, path LIMIT ?",
  );
  const del = db.query(
    "DELETE FROM facts WHERE scanner = ? AND path = ? AND used < ?",
  );
  const result: PruneResult = {
    rowsRead: 0,
    rowsDeleted: 0,
    transactions: 0,
    longestHoldMs: 0,
  };
  let after = { scanner: "", path: "" };
  try {
    for (;;) {
      const rows = KeyPage.parse(
        page.all(after.scanner, after.path, PRUNE_PAGE),
      );
      const last = rows.at(-1);
      if (last === undefined) break;
      result.rowsRead += rows.length;
      after = last;
      const stale = rows.filter((r) => r.used < cutoff);
      if (stale.length === 0) continue;
      const start = performance.now();
      db.transaction(() => {
        for (const r of stale)
          result.rowsDeleted += del.run(r.scanner, r.path, cutoff).changes;
      })();
      result.transactions++;
      result.longestHoldMs = Math.max(
        result.longestHoldMs,
        performance.now() - start,
      );
    }
    db.query(
      "INSERT INTO meta (name, value) VALUES ('pruned', ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value",
    ).run(String(day));
  } finally {
    db.close();
  }
  return result;
}
