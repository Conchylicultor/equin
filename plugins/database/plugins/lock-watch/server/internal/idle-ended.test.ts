/**
 * The idle-in-transaction timeout against a real Postgres, end to end: a
 * transaction left idle past a test-shortened bound is ended by the server,
 * its own client files the `db-idle-transaction-ended` report naming the
 * origin and statement of its last statement, its next call fails with
 * `IdleTransactionEndedError`, its write is rolled back — and the lock watch,
 * looking before and after, concludes the same session ended and leaves the
 * report to the client that owned it.
 *
 * The bound is the throwaway database's own `idle_in_transaction_session_timeout`
 * (1 s), so every session on it — the watch's included — reads that bound,
 * exactly as they read the cluster's 5 min in the app.
 *
 * Run: `./equin test plugins/database/plugins/lock-watch`
 * (requires the running embedded cluster).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Pool } from "pg";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { queryOne } from "@plugins/database/plugins/sql-rows/core";
import {
  createDbPool,
  idleTransactionEndedSink,
} from "@plugins/database/plugins/connection/server";
import { IdleTransactionEndedError } from "@plugins/database/plugins/connection/server/testing";
import { tagSqlWithOrigin } from "@plugins/database/plugins/connection/core";
import {
  installSpanContextRuntime,
  recordEntrySpan,
  type EntryContext,
} from "@plugins/infra/plugins/runtime-profiler/core";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { DB_IDLE_TRANSACTION_ENDED_KIND } from "../../core";
import { createIdleTransactionEndedHandler } from "./idle-ended-handler";
import { idleTransactionEndedFingerprint } from "./idle-ended-render";
import { noticeIdleEnds } from "./idle-ended-watch";
import { readSessionEnds, readSessions } from "./read-sessions";

const BOUND_MS = 1_000;

// The origin a client names is ambient: install the recorder's runtime as
// runtime-profiler/server does at boot.
const als = new AsyncLocalStorage<EntryContext>();
installSpanContextRuntime({
  run: (ctx, fn) => als.run(ctx, fn),
  current: () => als.getStore(),
});

let t: TestDb;
let holderPool: Pool;
let watchPool: Pool;

interface Recorded {
  kind: string;
  source: string;
  message: string;
  data: unknown;
}
const reports: Recorded[] = [];
const lines: string[] = [];

beforeAll(async () => {
  t = await createTestDb({ prefix: "idle_ended" });
  await t.db.execute(
    sql.raw(
      `ALTER DATABASE "${t.name}" SET idle_in_transaction_session_timeout = '${BOUND_MS}ms'`,
    ),
  );
  // Built after the setting, so every session on them starts with the bound.
  holderPool = createDbPool({
    name: "app-background",
    connectionString: t.connectionString,
    max: 1,
  });
  watchPool = createDbPool({
    name: "lock-watch",
    connectionString: t.connectionString,
    max: 1,
  });
  await watchPool.query(
    "CREATE TABLE usage_rows (id int PRIMARY KEY, n int NOT NULL)",
  );
  idleTransactionEndedSink.register(
    createIdleTransactionEndedHandler({
      recordReport: async (input) => {
        reports.push(input as Recorded);
        return { outcome: "recorded", reportId: "r-1" } as never;
      },
      log: (line) => lines.push(line),
    }),
  );
});

afterAll(async () => {
  idleTransactionEndedSink.register(null);
  await Promise.all([holderPool.end(), watchPool.end()]);
  await t.drop();
});

async function until(what: string, ok: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await ok()) return;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("a transaction left idle past the bound", () => {
  test("is ended by the server and reported with its origin — by its client, and seen by the watch", async () => {
    const holder = await holderPool.connect();
    const pid = await recordEntrySpan(
      "job",
      "conversations.usage:sync",
      async () => {
        await holder.query("BEGIN");
        await holder.query(
          tagSqlWithOrigin(
            "INSERT INTO usage_rows VALUES (1, 1)",
            "conversations.usage:sync",
          ),
        );
        // Tagged by hand, as the app pool tags every statement it sends.
        const row = await holder.query<{ pid: number }>(
          tagSqlWithOrigin(
            "SELECT pg_backend_pid() AS pid",
            "conversations.usage:sync",
          ),
        );
        return row.rows[0]!.pid;
      },
    );

    // The watch's first look: the session idle in its transaction.
    const look1Rows = await readSessions(watchPool);
    const look1Ends = await readSessionEnds(watchPool);
    expect(look1Ends.idleTimeoutMs).toBe(BOUND_MS);
    expect(look1Rows.find((r) => r.pid === pid)).toMatchObject({
      state: "idle in transaction",
      applicationName: "equin:app-background",
    });
    expect(noticeIdleEnds(look1Rows, look1Ends, Date.now())).toEqual([]);

    // The server ends it; its client reports it.
    await until("the client's report", () => reports.length > 0);
    expect(reports).toHaveLength(1);
    const report = reports[0]!;
    expect(report.kind).toBe(DB_IDLE_TRANSACTION_ENDED_KIND);
    expect(report.source).toBe("server-caught");
    expect(report.data).toMatchObject({
      observedBy: "client",
      origin: "conversations.usage:sync",
      openedBy: "conversations.usage:sync",
      sql: "SELECT pg_backend_pid() AS pid",
      pool: "app-background",
    });
    const data = report.data as { idleMs: number; transactionMs: number };
    expect(data.idleMs).toBeGreaterThanOrEqual(BOUND_MS - 100);
    expect(data.transactionMs).toBeGreaterThanOrEqual(data.idleMs);
    expect(
      idleTransactionEndedFingerprint(
        report.data as Parameters<typeof idleTransactionEndedFingerprint>[0],
      ),
    ).toBe("db-idle-transaction-ended:conversations.usage:sync");
    expect(report.message).toStartWith(
      "The database ended conversations.usage:sync's transaction after ",
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith("[idle-tx] pool=app-background session ended");

    // The session is gone and its write rolled back.
    const sessions = await readSessions(watchPool);
    expect(sessions.some((r) => r.pid === pid)).toBe(false);
    const count = await queryOne(watchPool, {
      sql: "SELECT count(*)::int AS n FROM usage_rows",
      row: z.object({ n: z.number() }),
    });
    expect(count.n).toBe(0);

    // The stalled code's next call says why.
    const next = await holder.query("SELECT 1").then(
      () => null,
      (err: unknown) => err,
    );
    expect(next).toBeInstanceOf(IdleTransactionEndedError);
    expect((next as Error).message).toContain(
      "idle_in_transaction_session_timeout",
    );
    holder.release();

    // The watch's next look: gone, and ended on a FATAL since — it concludes
    // the timeout ended it, and leaves the report to the client that owned it.
    await until(
      "the reaped backend's FATAL end in pg_stat_database",
      async () =>
        (await readSessionEnds(watchPool)).sessionsFatal >
        look1Ends.sessionsFatal,
    );
    const ended = noticeIdleEnds(
      await readSessions(watchPool),
      await readSessionEnds(watchPool),
      Date.now(),
    );
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({
      clientReports: true,
      data: {
        observedBy: "lock-watch",
        origin: "conversations.usage:sync",
        sql: "SELECT pg_backend_pid() AS pid",
        pid,
        applicationName: "equin:app-background",
        boundMs: BOUND_MS,
      },
    });
  });

  test("a transaction that keeps talking is never ended", async () => {
    const before = reports.length;
    const holder = await holderPool.connect();
    await holder.query("BEGIN");
    for (let i = 0; i < 4; i++) {
      await holder.query("SELECT 1");
      await Bun.sleep(BOUND_MS / 2);
    }
    await holder.query("COMMIT");
    holder.release();
    expect(reports.length).toBe(before);
  });
});
