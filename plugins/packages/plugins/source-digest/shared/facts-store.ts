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
// removed worktree's files, a retired scanner.

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
const MetaRow = z.object({ value: z.string() });

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

function open(scannerModule: string): Promise<Open> {
  opened ??= (async () => {
    const scanner = await scannerOf(scannerModule);
    const dir = await sourceFactsDir.ensure();
    const db = new Database(`${dir}/facts.sqlite`, { create: true });
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    // Every write is one short transaction (a walk batch's new rows); a
    // writer waits only for another process's equally short one.
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec(
      "CREATE TABLE IF NOT EXISTS facts (scanner TEXT NOT NULL, path TEXT NOT NULL, stamp TEXT NOT NULL, sha256 TEXT NOT NULL, imports TEXT NOT NULL, used INTEGER NOT NULL, PRIMARY KEY (scanner, path)) WITHOUT ROWID",
    );
    db.exec(
      "CREATE TABLE IF NOT EXISTS meta (name TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID",
    );
    const day = today();
    const pruned = MetaRow.nullable().parse(
      db.query("SELECT value FROM meta WHERE name = 'pruned'").get(),
    );
    if (pruned === null || Number(pruned.value) < day) {
      db.transaction(() => {
        db.query("DELETE FROM facts WHERE used < ?").run(day - KEEP_DAYS);
        db.query(
          "INSERT INTO meta (name, value) VALUES ('pruned', ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value",
        ).run(String(day));
      })();
    }
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
