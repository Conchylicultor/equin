import { Database } from "bun:sqlite";
import { z } from "zod";
import { foldKeyOf, type GrepIndexStore } from "../../core";
import { checkGrepIndexDir } from "../../data-dirs";

/**
 * The shared grep index (`core/grep-index.ts`): one SQLite database (WAL, so
 * every worktree's check run reads and writes it at once) under the data root.
 *
 * An answer never goes stale — its key names everything it is a function of —
 * so the only maintenance is reclaiming the ones nobody asks for any more: a row
 * keeps the day it was last read, refreshed at most once a day, and rows unread
 * for {@link KEEP_DAYS} are deleted by {@link pruneGrepIndex}, which the daily
 * checks.grep-index-prune job runs (main only). It used to run inside the
 * first open of each UTC day — whole-table DELETEs over a GB-sized file — so
 * the check runs opening the store just after midnight raced for that write
 * and waited behind it (the same race as source-digest's facts store,
 * 2026-11-18).
 *
 * Compact on purpose: one row per (query, blob) — ~100 queries × every blob
 * version the host has seen — so a query is an integer and a blob its raw bytes.
 * A fold (a directory's record) is one row per (scope, directory path, id):
 * the scope an integer like a query, the id (a tree id or a names digest) raw.
 */

const KEEP_DAYS = 14;
// Under SQLite's default bound on host parameters per statement (32766).
const BATCH = 500;

const QueryRow = z.object({ id: z.number() });
const FoldRows = z.array(
  z.object({
    path: z.string(),
    id: z.instanceof(Uint8Array),
    value: z.string(),
    used: z.number(),
  }),
);
const AnswerRows = z.array(
  z.object({
    blob: z.instanceof(Uint8Array),
    matched: z.number(),
    used: z.number(),
  }),
);

function today(): number {
  return Math.floor(Date.now() / 86_400_000);
}

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const raw = (blob: string): Uint8Array => Buffer.from(blob, "hex");

/** The grep index database, its schema made. */
function openGrepIndexDb(path?: string): Database {
  const file =
    path ??
    (checkGrepIndexDir.ensureSync(),
    checkGrepIndexDir.file("grep-index.sqlite"));
  const db = new Database(file, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 30000");
  db.exec(
    "CREATE TABLE IF NOT EXISTS queries (id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE)",
  );
  db.exec(
    "CREATE TABLE IF NOT EXISTS answers (query INTEGER NOT NULL, blob BLOB NOT NULL, matched INTEGER NOT NULL, used INTEGER NOT NULL, PRIMARY KEY (query, blob)) WITHOUT ROWID",
  );
  db.exec(
    "CREATE TABLE IF NOT EXISTS folds (scope INTEGER NOT NULL, path TEXT NOT NULL, id BLOB NOT NULL, value TEXT NOT NULL, used INTEGER NOT NULL, PRIMARY KEY (scope, path, id)) WITHOUT ROWID",
  );
  db.exec(
    "CREATE TABLE IF NOT EXISTS meta (name TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID",
  );
  return db;
}

export function openGrepIndexStore(opts?: { path?: string }): GrepIndexStore {
  const db = openGrepIndexDb(opts?.path);
  // No maintenance here: the prune is the daily checks.grep-index-prune job's
  // (`pruneGrepIndex`), off every check run's path.
  const day = today();

  const queryIds = new Map<string, number>();
  const queryId = (key: string): number => {
    const known = queryIds.get(key);
    if (known !== undefined) return known;
    db.query(
      "INSERT INTO queries (key) VALUES (?) ON CONFLICT (key) DO NOTHING",
    ).run(key);
    const { id } = QueryRow.parse(
      db.query("SELECT id FROM queries WHERE key = ?").get(key),
    );
    queryIds.set(key, id);
    return id;
  };
  const select = (n: number) =>
    db.query(
      `SELECT blob, matched, used FROM answers WHERE query = ? AND blob IN (${Array(n).fill("?").join(",")})`,
    );
  const touch = (n: number) =>
    db.query(
      `UPDATE answers SET used = ? WHERE query = ? AND blob IN (${Array(n).fill("?").join(",")})`,
    );
  // A fold is asked by (path, id) pairs: a row-value IN over the primary key.
  const selectFolds = (n: number) =>
    db.query(
      `SELECT path, id, value, used FROM folds WHERE scope = ? AND (path, id) IN (VALUES ${Array(n).fill("(?, ?)").join(",")})`,
    );
  const touchFold = db.query(
    "UPDATE folds SET used = ? WHERE scope = ? AND path = ? AND id = ?",
  );
  const insertFold = db.query(
    "INSERT INTO folds (scope, path, id, value, used) VALUES (?, ?, ?, ?, ?) ON CONFLICT (scope, path, id) DO NOTHING",
  );
  const insert = db.query(
    "INSERT INTO answers (query, blob, matched, used) VALUES (?, ?, ?, ?) ON CONFLICT (query, blob) DO NOTHING",
  );

  return {
    answers(query, blobs) {
      const id = queryId(query);
      const out = new Map<string, boolean>();
      const stale: Uint8Array[] = [];
      for (let i = 0; i < blobs.length; i += BATCH) {
        const chunk = blobs.slice(i, i + BATCH).map(raw);
        for (const row of AnswerRows.parse(
          select(chunk.length).all(id, ...chunk),
        )) {
          out.set(hex(row.blob), row.matched === 1);
          if (row.used < day) stale.push(row.blob);
        }
      }
      if (stale.length > 0)
        db.transaction(() => {
          for (let i = 0; i < stale.length; i += BATCH) {
            const chunk = stale.slice(i, i + BATCH);
            touch(chunk.length).run(day, id, ...chunk);
          }
        })();
      return out;
    },
    folds(scope, keys) {
      const id = queryId(scope);
      const out = new Map<string, string>();
      const stale: Array<{ path: string; id: Uint8Array }> = [];
      // Two host parameters per key.
      const per = Math.floor(BATCH / 2);
      for (let i = 0; i < keys.length; i += per) {
        const chunk = keys.slice(i, i + per);
        const params = chunk.flatMap((k) => [k.path, raw(k.id)]);
        for (const row of FoldRows.parse(
          selectFolds(chunk.length).all(id, ...params),
        )) {
          out.set(foldKeyOf({ path: row.path, id: hex(row.id) }), row.value);
          if (row.used < day) stale.push({ path: row.path, id: row.id });
        }
      }
      if (stale.length > 0)
        db.transaction(() => {
          for (const k of stale) touchFold.run(day, id, k.path, k.id);
        })();
      return out;
    },
    recordFolds(scope, folds) {
      if (folds.length === 0) return;
      const id = queryId(scope);
      db.transaction(() => {
        for (const [key, value] of folds)
          insertFold.run(id, key.path, raw(key.id), value, day);
      })();
    },
    record(query, answers) {
      if (answers.length === 0) return;
      const id = queryId(query);
      db.transaction(() => {
        for (const [blob, matched] of answers)
          insert.run(id, raw(blob), matched ? 1 : 0, day);
      })();
    },
  };
}

/** Rows the prune reads per page, and deletes per transaction at most. */
const PRUNE_PAGE = 1000;

export interface GrepIndexPruneResult {
  rowsRead: number;
  rowsDeleted: number;
  /** Write transactions taken, and the longest one held the lock. */
  transactions: number;
  longestHoldMs: number;
}

/** A pruned table: its name and primary-key columns, in key order. */
const PRUNED_TABLES = [
  { table: "answers", key: ["query", "blob"] },
  { table: "folds", key: ["scope", "path", "id"] },
] as const;

type KeyValue = number | string | Uint8Array;
const PruneRows = z.array(
  z.record(
    z.string(),
    z.union([z.number(), z.string(), z.instanceof(Uint8Array)]),
  ),
);

/** A row's key, in key order — every column the page selected. */
function keyOfRow(
  row: Record<string, KeyValue>,
  key: readonly string[],
): KeyValue[] {
  return key.map((c) => {
    const v = row[c];
    if (v === undefined)
      throw new Error(`[grep-index] prune page row lacks key column ${c}`);
    return v;
  });
}

/**
 * Deletes the rows unread for {@link KEEP_DAYS} without ever holding the store
 * long: each table is read a page at a time in primary-key order (a WAL read,
 * no lock), and only a page's stale rows are deleted, in one short
 * transaction each, re-checked under the lock (a check run may have read the
 * row since). O(rows) to read, O(what it deletes) to write.
 *
 * Then stamps the old daily marker, so a checkout still on the code that
 * pruned inside its first open of the day does not run those whole-table
 * DELETEs again today.
 */
export function pruneGrepIndex(opts?: {
  path?: string;
  /** Today, as a day number (tests). */
  day?: number;
}): GrepIndexPruneResult {
  const db = openGrepIndexDb(opts?.path);
  const day = opts?.day ?? today();
  const cutoff = day - KEEP_DAYS;
  const result: GrepIndexPruneResult = {
    rowsRead: 0,
    rowsDeleted: 0,
    transactions: 0,
    longestHoldMs: 0,
  };
  try {
    for (const { table, key } of PRUNED_TABLES) {
      const cols = key.join(", ");
      const marks = key.map(() => "?").join(", ");
      const first = db.query(
        `SELECT ${cols}, used FROM ${table} ORDER BY ${cols} LIMIT ?`,
      );
      const next = db.query(
        `SELECT ${cols}, used FROM ${table} WHERE (${cols}) > (${marks}) ORDER BY ${cols} LIMIT ?`,
      );
      const del = db.query(
        `DELETE FROM ${table} WHERE ${key.map((c) => `${c} = ?`).join(" AND ")} AND used < ?`,
      );
      let after: KeyValue[] | null = null;
      for (;;) {
        const rows = PruneRows.parse(
          after === null
            ? first.all(PRUNE_PAGE)
            : next.all(...after, PRUNE_PAGE),
        );
        const last = rows.at(-1);
        if (last === undefined) break;
        result.rowsRead += rows.length;
        after = keyOfRow(last, key);
        const stale = rows.filter((r) => Number(r.used) < cutoff);
        if (stale.length === 0) continue;
        const start = performance.now();
        db.transaction(() => {
          for (const r of stale)
            result.rowsDeleted += del.run(...keyOfRow(r, key), cutoff).changes;
        })();
        result.transactions++;
        result.longestHoldMs = Math.max(
          result.longestHoldMs,
          performance.now() - start,
        );
      }
    }
    db.query(
      "INSERT INTO meta (name, value) VALUES ('pruned', ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value",
    ).run(String(day));
  } finally {
    db.close();
  }
  return result;
}
