/**
 * The lock watch against a real Postgres: one session takes a row lock inside a
 * transaction and goes idle (the 2026-11-03 shape), a second queues behind it,
 * and the watch's own read + analysis names the holder by the origin its
 * statement carries — with the report it would file.
 *
 * Run: `./equin test plugins/database/plugins/lock-watch`
 * (requires the running embedded cluster).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { queryOne } from "@plugins/database/plugins/sql-rows/core";
import { createDbPool } from "@plugins/database/plugins/connection/server";
import { tagSqlWithOrigin } from "@plugins/database/plugins/connection/core";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { lockHolders, type SessionRow } from "../../core";
import { readSessions } from "./read-sessions";
import { lockHolderFingerprint, lockHolderMessage } from "./render";

let t: TestDb;
let holderPool: Pool;
let waiterPool: Pool;
let watchPool: Pool;

function pool(): Pool {
  return createDbPool({
    name: "admin-short-lived",
    connectionString: t.connectionString,
    max: 1,
  });
}

beforeAll(async () => {
  t = await createTestDb({ prefix: "lock_watch" });
  holderPool = pool();
  waiterPool = pool();
  watchPool = pool();
  await watchPool.query(
    "CREATE TABLE usage_rows (id int PRIMARY KEY, n int NOT NULL)",
  );
  await watchPool.query("INSERT INTO usage_rows VALUES (1, 0)");
});

afterAll(async () => {
  await Promise.all([holderPool.end(), waiterPool.end(), watchPool.end()]);
  await t.drop();
});

// The watch looks once; here the waiter must have reached the lock manager
// before the look means anything, so read until it has (a handful of reads).
async function readUntilBlocked(): Promise<SessionRow[]> {
  for (let i = 0; i < 100; i++) {
    const rows = await readSessions(watchPool);
    if (rows.some((r) => r.blockedBy.length > 0)) return rows;
    await Bun.sleep(20);
  }
  throw new Error("the waiter never showed as blocked in pg_stat_activity");
}

describe("lock watch on a real database", () => {
  test("names the idle-in-transaction holder of a row lock by its origin", async () => {
    const holder: PoolClient = await holderPool.connect();
    await holder.query("BEGIN");
    await holder.query(
      tagSqlWithOrigin(
        "UPDATE usage_rows SET n = n + 1 WHERE id = 1",
        "conversations.usage:sync",
      ),
    );
    // The holder now sits idle in its transaction, holding the row lock; the
    // waiter queues on it.
    const waiter = waiterPool.query(
      "UPDATE usage_rows SET n = n + 10 WHERE id = 1",
    );

    const rows = await readUntilBlocked();
    // Threshold 0: this test is about who is named, not about how long.
    const holders = lockHolders(rows, 0);
    expect(holders).toHaveLength(1);
    const h = holders[0]!;
    expect(h).toMatchObject({
      origin: "conversations.usage:sync",
      sql: "UPDATE usage_rows SET n = n + 1 WHERE id = 1",
      state: "idle in transaction",
      waiting: 1,
    });
    expect(h.idleMs).not.toBeNull();
    expect(h.xactMs).not.toBeNull();

    const data = { ...h, thresholdMs: 0 };
    expect(lockHolderFingerprint(data)).toBe(
      "db-lock-holder:conversations.usage:sync",
    );
    expect(lockHolderMessage(data)).toStartWith(
      "conversations.usage:sync holds 1 session (longest wait ",
    );

    // The watch never ends a session: the chain frees only when its holder does.
    await holder.query("COMMIT");
    holder.release();
    await waiter;
    const after = await queryOne(watchPool, {
      sql: "SELECT n FROM usage_rows WHERE id = 1",
      row: z.object({ n: z.number() }),
    });
    expect(after.n).toBe(11);
    expect(lockHolders(await readSessions(watchPool), 0)).toEqual([]);
  });
});
