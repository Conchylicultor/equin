import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";

// The mechanism behind the table mirror's hard requirement — every deletion on
// the source, cascaded and retention ones included, reaches the mirror — pinned
// on raw Postgres, independently of the generated triggers: a statement-level
// AFTER DELETE trigger with a transition table on a CHILD sees the rows an FK
// `ON DELETE CASCADE` removed from it when the parent row is deleted.
let t: TestDb;

beforeAll(async () => {
  t = await createTestDb({ prefix: "tm_cascade" });
  await t.db.execute(
    sql.raw(`
    CREATE TABLE parent (id int PRIMARY KEY);
    CREATE TABLE child (id int PRIMARY KEY, parent_id int NOT NULL REFERENCES parent(id) ON DELETE CASCADE);
    CREATE TABLE grandchild (id int PRIMARY KEY, child_id int NOT NULL REFERENCES child(id) ON DELETE CASCADE);
    CREATE TABLE seen (tbl text, id int, op text);
    CREATE FUNCTION log_deleted() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO seen SELECT TG_TABLE_NAME, id, TG_OP FROM old_rows;
      RETURN NULL;
    END $$;
    CREATE FUNCTION log_truncated() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO seen VALUES (TG_TABLE_NAME, NULL, TG_OP);
      RETURN NULL;
    END $$;
    CREATE TRIGGER parent_del AFTER DELETE ON parent REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION log_deleted();
    CREATE TRIGGER child_del AFTER DELETE ON child REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION log_deleted();
    CREATE TRIGGER grandchild_del AFTER DELETE ON grandchild REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION log_deleted();
    CREATE TRIGGER parent_trunc AFTER TRUNCATE ON parent FOR EACH STATEMENT EXECUTE FUNCTION log_truncated();
    CREATE TRIGGER child_trunc AFTER TRUNCATE ON child FOR EACH STATEMENT EXECUTE FUNCTION log_truncated();
  `),
  );
});

afterAll(async () => {
  await t.drop();
});

async function seen(): Promise<string[]> {
  const r = await t.db.execute<{ row: string }>(
    sql.raw(
      `SELECT tbl || ':' || coalesce(id::text, '-') || ':' || op AS row FROM seen ORDER BY 1`,
    ),
  );
  return r.rows.map((x) => x.row);
}

describe("statement-level transition tables under ON DELETE CASCADE", () => {
  test("a parent delete fires the child's and grandchild's statement triggers with the cascaded rows", async () => {
    await t.db.execute(
      sql.raw(`
      TRUNCATE seen;
      INSERT INTO parent VALUES (1), (2);
      INSERT INTO child VALUES (10, 1), (11, 1), (20, 2);
      INSERT INTO grandchild VALUES (100, 10), (101, 11), (200, 20);
    `),
    );
    // A retention-like bulk delete: one statement, several parents.
    await t.db.execute(sql.raw(`DELETE FROM parent WHERE id = 1`));
    expect(await seen()).toEqual([
      "child:10:DELETE",
      "child:11:DELETE",
      "grandchild:100:DELETE",
      "grandchild:101:DELETE",
      "parent:1:DELETE",
    ]);
  });

  test("TRUNCATE … CASCADE fires the truncate trigger of every truncated table", async () => {
    await t.db.execute(sql.raw(`TRUNCATE seen; TRUNCATE parent CASCADE`));
    expect(await seen()).toEqual(["child:-:TRUNCATE", "parent:-:TRUNCATE"]);
  });
});
