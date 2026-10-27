/**
 * The database rewrite against a real Postgres (db-test-fixture): a stored path
 * in a text, varchar, json or jsonb column is rewritten; a mention inside prose
 * is left as written; the scan reads clean afterwards; and a trigger on the
 * table does not fire (the rewrite moves bytes, it does not change the row).
 *
 * Run: `./equin test plugins/infra/plugins/paths/plugins/root-migration`
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { readDatabaseConfig } from "@plugins/database/core";
import { rewriteDatabase, scanDatabase } from "./databases";

const MOVES = [{ from: "/home/u/.old", to: "/home/u/.equin" }];

let testDb: TestDb;
let name: string;

beforeAll(async () => {
  testDb = await createTestDb({ prefix: "root_migration" });
  // `postgres://<user>@/<db>?host=…` — a socket URL `URL` cannot parse.
  const match = /@[^/]*\/([^?]+)/.exec(testDb.connectionString);
  if (match?.[1] === undefined) {
    throw new Error(`no database in ${testDb.connectionString}`);
  }
  name = decodeURIComponent(match[1]);
  await testDb.db.execute(sql`
    CREATE TABLE t (
      id int PRIMARY KEY,
      path text,
      short varchar(200),
      doc jsonb,
      raw json,
      touched int NOT NULL DEFAULT 0
    )`);
  await testDb.db.execute(sql`
    CREATE FUNCTION bump() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN NEW.touched := OLD.touched + 1; RETURN NEW; END $$`);
  await testDb.db.execute(
    sql`CREATE TRIGGER bump BEFORE UPDATE ON t FOR EACH ROW EXECUTE FUNCTION bump()`,
  );
  await testDb.db.execute(sql`
    INSERT INTO t (id, path, short, doc, raw) VALUES
      (1, '/home/u/.old/apps/a.png', '/home/u/.old', '{"dir":"/home/u/.old/x","n":1}', '{"p":"/home/u/.old"}'),
      (2, 'see /home/u/.old/logs for details', 'unrelated', '{"text":"look in /home/u/.old/y"}', '{}'),
      (3, '/home/u/.older/z', NULL, NULL, NULL)`);
});

afterAll(async () => {
  await testDb.drop();
});

test("rewrites stored paths, leaves prose, fires no trigger, scans clean", async () => {
  const conn = readDatabaseConfig().connection;
  expect((await scanDatabase(conn, name, MOVES)).length).toBeGreaterThan(0);

  const rows = await rewriteDatabase(conn, name, MOVES);
  expect(rows).toBe(1);

  const res = await testDb.db.execute(
    sql`SELECT id, path, short, doc::text AS doc, raw::text AS raw, touched FROM t ORDER BY id`,
  );
  expect(res.rows).toEqual([
    {
      id: 1,
      path: "/home/u/.equin/apps/a.png",
      short: "/home/u/.equin",
      doc: '{"n": 1, "dir": "/home/u/.equin/x"}',
      raw: '{"p":"/home/u/.equin"}',
      touched: 0,
    },
    {
      id: 2,
      path: "see /home/u/.old/logs for details",
      short: "unrelated",
      doc: '{"text": "look in /home/u/.old/y"}',
      raw: "{}",
      touched: 0,
    },
    {
      id: 3,
      path: "/home/u/.older/z",
      short: null,
      doc: null,
      raw: null,
      touched: 0,
    },
  ]);
  expect(await scanDatabase(conn, name, MOVES)).toEqual([]);
});
