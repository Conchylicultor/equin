import { beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { z } from "zod";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import { db, DatabaseDriver } from "./driver";
import type { DbExecutor } from "./current-tx-id";
import {
  atomicStatement,
  MAX_BIND_PARAMETERS,
  writeAtomically,
} from "./write-atomically";

// Real Postgres: the CTE's semantics (one statement, end-of-statement FK
// checks, one snapshot) are what this primitive promises, and only the server
// can judge them. Runs on the plugin's own worktree DB inside a transaction of
// TEMP tables (ON COMMIT DROP), so nothing persists — the same reason as
// current-tx-id.test.ts (the db-test-fixture is a child plugin: a cycle).

beforeAll(async () => {
  await DatabaseDriver.get().ready({ warm: false });
});

/** Run `fn` on a transaction holding fresh parent/child TEMP tables. */
async function withTables(fn: (tx: DbExecutor) => Promise<void>) {
  await db.transaction(async (tx) => {
    await tx.execute(
      sql.raw(
        `CREATE TEMP TABLE wa_parent (id int PRIMARY KEY, n int NOT NULL DEFAULT 0) ON COMMIT DROP`,
      ),
    );
    await tx.execute(
      sql.raw(
        `CREATE TEMP TABLE wa_child (id int PRIMARY KEY, parent int NOT NULL REFERENCES wa_parent(id)) ON COMMIT DROP`,
      ),
    );
    await fn(tx);
  });
}

const Row = z.object({ id: z.number(), n: z.number() });

async function parents(tx: DbExecutor) {
  return executeRows(tx, {
    label: "write-atomically.test: parents",
    row: Row,
    query: sql`SELECT id, n FROM wa_parent ORDER BY id`,
  });
}

describe("atomicStatement", () => {
  test("renders every arm as a CTE, unparenthesised", () => {
    const rendered = new PgDialect().sqlToQuery(
      atomicStatement([
        sql`INSERT INTO a VALUES (${1})`,
        sql`DELETE FROM b WHERE id = ${2}`,
      ]),
    );
    expect(rendered.sql).toBe(
      "WITH w0 AS (INSERT INTO a VALUES ($1)), w1 AS (DELETE FROM b WHERE id = $2) SELECT 1",
    );
    expect(rendered.params).toEqual([1, 2]);
  });
});

describe("writeAtomically", () => {
  test("runs every arm in one statement; a child may reference a sibling arm's parent", async () => {
    await withTables(async (tx) => {
      await writeAtomically(tx, [
        sql`INSERT INTO wa_parent (id) VALUES (1), (2)`,
        sql`INSERT INTO wa_child (id, parent) VALUES (10, 1)`,
        null,
        sql`INSERT INTO wa_parent (id, n) VALUES (3, 7)`,
      ]);
      expect(await parents(tx)).toEqual([
        { id: 1, n: 0 },
        { id: 2, n: 0 },
        { id: 3, n: 7 },
      ]);
    });
  });

  test("is atomic: one failing arm writes nothing", async () => {
    await withTables(async (tx) => {
      // A savepoint, so the failure does not abort the test's transaction.
      expect(
        tx.transaction(async (sp) => {
          await writeAtomically(sp, [
            sql`INSERT INTO wa_parent (id) VALUES (1)`,
            sql`INSERT INTO wa_child (id, parent) VALUES (10, 99)`,
          ]);
        }),
      ).rejects.toThrow();
      expect(await parents(tx)).toEqual([]);
    });
  });

  test("every arm sees the snapshot from before the statement", async () => {
    await withTables(async (tx) => {
      await tx.execute(sql`INSERT INTO wa_parent (id, n) VALUES (1, 1)`);
      // The update cannot see the row the insert arm adds.
      await writeAtomically(tx, [
        sql`INSERT INTO wa_parent (id) VALUES (2)`,
        sql`UPDATE wa_parent SET n = n + 1`,
      ]);
      expect(await parents(tx)).toEqual([
        { id: 1, n: 2 },
        { id: 2, n: 0 },
      ]);
    });
  });

  test("a key deleted by one arm cannot be re-inserted by another", async () => {
    await withTables(async (tx) => {
      await tx.execute(sql`INSERT INTO wa_parent (id) VALUES (1)`);
      expect(
        tx.transaction(async (sp) => {
          await writeAtomically(sp, [
            sql`DELETE FROM wa_parent WHERE id = 1`,
            sql`INSERT INTO wa_parent (id) VALUES (1)`,
          ]);
        }),
      ).rejects.toThrow();
    });
  });

  test("one write runs as itself; none issues nothing", async () => {
    await withTables(async (tx) => {
      await writeAtomically(tx, [
        null,
        sql`INSERT INTO wa_parent (id) VALUES (5)`,
      ]);
      await writeAtomically(tx, []);
      await writeAtomically(tx, [null]);
      expect(await parents(tx)).toEqual([{ id: 5, n: 0 }]);
    });
  });

  test("refuses an arm that is not a write, before any round trip", () => {
    expect(
      writeAtomically(db, [
        sql`INSERT INTO wa_never (id) VALUES (1)`,
        sql`SELECT 1`,
      ]),
    ).rejects.toThrow(/arm 1 is not an INSERT, UPDATE or DELETE/);
  });

  test("refuses a group past one statement's bind parameters", () => {
    const half = Math.ceil((MAX_BIND_PARAMETERS + 1) / 2);
    const values = (n: number) =>
      sql.join(
        Array.from({ length: n }, (_, i) => sql`(${i})`),
        sql`, `,
      );
    expect(
      writeAtomically(db, [
        sql`INSERT INTO wa_never (id) VALUES ${values(half)}`,
        sql`INSERT INTO wa_never (id) VALUES ${values(half)}`,
      ]),
    ).rejects.toThrow(/past one statement's 65535/);
  });
});
