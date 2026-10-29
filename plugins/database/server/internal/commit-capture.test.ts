import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { executeOne } from "@plugins/database/plugins/sql-rows/core";
import { z } from "zod";
import { db, DatabaseDriver } from "./driver";
import { dbCommitCapture, inCommitScope, noteCommit } from "./commit-capture";
import { snapshotWatermark } from "./snapshot-watermark";

// Real-DB suite for the commit capture a predicted write's handler runs under
// (`commit-capture.ts`): every transaction it commits through `db` — a
// top-level `db.transaction`, or an autocommit write — is attributed to it, in
// commit order, and only those. Runs against the plugin's OWN worktree DB (see
// `current-tx-id.test.ts` for why not a throwaway): it writes nothing — each
// transaction is assigned an xid by `pg_current_xact_id()` alone.

/** The xid a transaction is assigned, read inside it. */
const XID = sql.raw("SELECT pg_current_xact_id()::text AS xid");
const xidRow = z.object({ xid: z.string() });

describe("dbCommitCapture", () => {
  test("attributes each committed top-level transaction, in commit order", async () => {
    await DatabaseDriver.get().ready({ warm: false });
    const { value, commits } = await dbCommitCapture.run(async () => {
      expect(inCommitScope()).toBe(true);
      const first = await db.transaction((tx) =>
        executeOne(tx, { query: XID, row: xidRow }),
      );
      const second = await db.transaction((tx) =>
        executeOne(tx, { query: XID, row: xidRow }),
      );
      return [first.xid, second.xid];
    });
    expect(commits).toEqual(value);
    expect(inCommitScope()).toBe(false);
  });

  test("attributes an autocommit write, and a full snapshot after it is past it", async () => {
    await DatabaseDriver.get().ready({ warm: false });
    const { commits } = await dbCommitCapture.run(async () => {
      // A `WITH` is run as a write: its own transaction, its xid read inside.
      await db.execute(
        sql.raw(
          "WITH x AS (SELECT pg_current_xact_id()::text AS id) SELECT id FROM x",
        ),
      );
    });
    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatch(/^\d+$/);
    const wm = await snapshotWatermark(db);
    expect(BigInt(wm) > BigInt(commits[0]!)).toBe(true);
  });

  test("a rolled-back transaction, a read-only one and one outside the scope are not attributed", async () => {
    await DatabaseDriver.get().ready({ warm: false });
    const outside = await db.transaction((tx) =>
      executeOne(tx, { query: XID, row: xidRow }),
    );
    const { commits } = await dbCommitCapture.run(async () => {
      await db.transaction((tx) => tx.execute(sql.raw("SELECT 1")));
      await db
        .transaction(async (tx) => {
          await executeOne(tx, { query: XID, row: xidRow });
          throw new Error("rollback");
        })
        .catch((err: unknown) => {
          if (!(err instanceof Error && err.message === "rollback")) throw err;
        });
    });
    expect(commits).toEqual([]);
    expect(outside.xid).toMatch(/^\d+$/);
  });

  test("noteCommit refuses what is not a transaction id", () => {
    expect(() => noteCommit("abc")).toThrow(/not a transaction id/);
    noteCommit(null);
  });
});
