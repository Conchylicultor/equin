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
 * for {@link KEEP_DAYS} are deleted, at most once a day per database.
 *
 * Compact on purpose: one row per (query, blob) — ~100 queries × every blob
 * version the host has seen — so a query is an integer and a blob its raw bytes.
 * A fold (a directory's record) is one row per (scope, directory path, id):
 * the scope an integer like a query, the id (a tree id or a names digest) raw.
 */

const KEEP_DAYS = 14;
// Under SQLite's default bound on host parameters per statement (32766).
const BATCH = 500;

const MetaRow = z.object({ value: z.string() });
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

export function openGrepIndexStore(opts?: { path?: string }): GrepIndexStore {
  const path =
    opts?.path ??
    (checkGrepIndexDir.ensureSync(),
    checkGrepIndexDir.file("grep-index.sqlite"));
  const db = new Database(path, { create: true });
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
  const day = today();
  const pruned = MetaRow.nullable().parse(
    db.query("SELECT value FROM meta WHERE name = ?").get("pruned"),
  );
  if (pruned === null || Number(pruned.value) < day) {
    db.transaction(() => {
      db.query("DELETE FROM answers WHERE used < ?").run(day - KEEP_DAYS);
      db.query("DELETE FROM folds WHERE used < ?").run(day - KEEP_DAYS);
      db.query(
        "INSERT INTO meta (name, value) VALUES ('pruned', ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value",
      ).run(String(day));
    })();
  }

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
