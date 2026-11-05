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
 * most once a day, and once a day per database the rows unread for
 * {@link KEEP_DAYS} are deleted, then every value no row names, and the freed
 * pages are returned to the filesystem.
 */

const KEEP_DAYS = 7;
// SQLite's default bound on host parameters per statement is 32766; a batch
// stays well under it.
const BATCH = 500;
// The first store's file (text keys, a value per row): unlinked on the daily
// reclaim, so its gigabytes go once every checkout reads this one.
const LEGACY_FILE = "records.sqlite";
const FILE = "records.v2.sqlite";
// A record key is a sha256 (`recordKey`), stored as its 32 bytes.
const KEY = /^[0-9a-f]{64}$/;

const MetaRow = z.object({ value: z.string() });
const RecordRows = z.array(
  z.object({
    key: z.instanceof(Uint8Array),
    value: z.string(),
    used: z.number(),
  }),
);

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

export function openRecordStore(opts?: { path?: string }): RecordStore {
  const path =
    opts?.path ?? (pluginRecordsDir.ensure(), pluginRecordsDir.file(FILE));
  const db = new Database(path, { create: true });
  // First, so every statement after it — the first open's own pragmas
  // included, when several processes create the file at once — waits for a
  // writer instead of failing.
  db.exec("PRAGMA busy_timeout = 30000");
  // Before any table exists, or it does not take: a reclaim can then return
  // its freed pages (`incremental_vacuum`) without rewriting the file.
  db.exec("PRAGMA auto_vacuum = INCREMENTAL");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(
    "CREATE TABLE IF NOT EXISTS keys (tbl TEXT NOT NULL, key BLOB NOT NULL, vid BLOB NOT NULL, used INTEGER NOT NULL, PRIMARY KEY (tbl, key)) WITHOUT ROWID",
  );
  db.exec("CREATE INDEX IF NOT EXISTS keys_vid ON keys (vid)");
  db.exec(
    "CREATE TABLE IF NOT EXISTS vals (vid BLOB PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID",
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
      db.query("DELETE FROM keys WHERE used < ?").run(day - KEEP_DAYS);
      db.exec(
        "DELETE FROM vals WHERE NOT EXISTS (SELECT 1 FROM keys WHERE keys.vid = vals.vid)",
      );
      db.query(
        "INSERT INTO meta (name, value) VALUES ('pruned', ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value",
      ).run(String(day));
    })();
    db.exec("PRAGMA incremental_vacuum");
    if (opts?.path === undefined)
      for (const suffix of ["", "-wal", "-shm"])
        rmSync(pluginRecordsDir.file(`${LEGACY_FILE}${suffix}`), {
          force: true,
        });
  }

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

  return {
    environment: `bun ${Bun.version} ${process.platform}-${process.arch}`,
    getMany(table, keys) {
      const tbl = tableId(table);
      const out = new Map<string, string>();
      const stale: Buffer[] = [];
      for (let i = 0; i < keys.length; i += BATCH) {
        const chunk = keys.slice(i, i + BATCH).map(keyBytes);
        for (const row of RecordRows.parse(
          select(chunk.length).all(tbl, ...chunk),
        )) {
          out.set(Buffer.from(row.key).toString("hex"), row.value);
          if (row.used < day) stale.push(Buffer.from(row.key));
        }
      }
      if (stale.length > 0) {
        db.transaction(() => {
          for (let i = 0; i < stale.length; i += BATCH) {
            const chunk = stale.slice(i, i + BATCH);
            touch(chunk.length).run(day, tbl, ...chunk);
          }
        })();
      }
      return out;
    },
    putMany(table, entries) {
      const tbl = tableId(table);
      if (entries.length === 0) return;
      db.transaction(() => {
        for (const [k, v] of entries) {
          const vid = new Bun.CryptoHasher("sha256").update(v).digest();
          insertValue.run(vid, v);
          insertKey.run(tbl, keyBytes(k), vid, day);
        }
      })();
    },
  };
}
