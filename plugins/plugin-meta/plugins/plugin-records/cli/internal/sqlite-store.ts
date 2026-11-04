import { Database } from "bun:sqlite";
import { z } from "zod";
import { RECORD_TABLES, type RecordStore, type RecordTable } from "../../core";
import { pluginRecordsDir } from "../../data-dirs";

/**
 * The shared record store: one SQLite database (WAL, so every worktree's build
 * reads and writes it at once) under the data root.
 *
 * Records never go stale — a key is the hash of its inputs — so the only
 * maintenance is reclaiming the ones nobody asks for any more: each row keeps
 * the day it was last read, refreshed at most once a day, and rows unread for
 * {@link KEEP_DAYS} are deleted, at most once a day per database.
 */

const KEEP_DAYS = 14;
// SQLite's default bound on host parameters per statement is 32766; a batch
// stays well under it.
const BATCH = 500;

const MetaRow = z.object({ value: z.string() });
const RecordRows = z.array(
  z.object({ key: z.string(), value: z.string(), used: z.number() }),
);

function today(): number {
  return Math.floor(Date.now() / 86_400_000);
}

export function openRecordStore(opts?: { path?: string }): RecordStore {
  const path =
    opts?.path ??
    (pluginRecordsDir.ensure(), pluginRecordsDir.file("records.sqlite"));
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 30000");
  db.exec(
    "CREATE TABLE IF NOT EXISTS records (tbl TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, used INTEGER NOT NULL, PRIMARY KEY (tbl, key)) WITHOUT ROWID",
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
      db.query("DELETE FROM records WHERE used < ?").run(day - KEEP_DAYS);
      db.query(
        "INSERT INTO meta (name, value) VALUES ('pruned', ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value",
      ).run(String(day));
    })();
  }

  const select = (n: number) =>
    db.query(
      `SELECT key, value, used FROM records WHERE tbl = ? AND key IN (${Array(n).fill("?").join(",")})`,
    );
  const touch = (n: number) =>
    db.query(
      `UPDATE records SET used = ? WHERE tbl = ? AND key IN (${Array(n).fill("?").join(",")})`,
    );
  const insert = db.query(
    "INSERT INTO records (tbl, key, value, used) VALUES (?, ?, ?, ?) ON CONFLICT (tbl, key) DO NOTHING",
  );

  const assertTable = (t: RecordTable): void => {
    if (!RECORD_TABLES.includes(t))
      throw new Error(`[plugin-records] unknown record table ${t}`);
  };

  return {
    environment: `bun ${Bun.version} ${process.platform}-${process.arch}`,
    getMany(table, keys) {
      assertTable(table);
      const out = new Map<string, string>();
      const stale: string[] = [];
      for (let i = 0; i < keys.length; i += BATCH) {
        const chunk = keys.slice(i, i + BATCH);
        for (const row of RecordRows.parse(
          select(chunk.length).all(table, ...chunk),
        )) {
          out.set(row.key, row.value);
          if (row.used < day) stale.push(row.key);
        }
      }
      if (stale.length > 0) {
        db.transaction(() => {
          for (let i = 0; i < stale.length; i += BATCH) {
            const chunk = stale.slice(i, i + BATCH);
            touch(chunk.length).run(day, table, ...chunk);
          }
        })();
      }
      return out;
    },
    putMany(table, entries) {
      assertTable(table);
      if (entries.length === 0) return;
      db.transaction(() => {
        for (const [k, v] of entries) insert.run(table, k, v, day);
      })();
    },
  };
}
