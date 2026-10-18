/**
 * Real-DB proof that an enqueue cannot wait forever: graphile's `addJob`, run
 * through a `jobs-enqueue` pool whose connection stops answering, rejects with
 * the connection plugin's `QueryDeadlineExceededError` naming that pool.
 *
 * `worker.ts` builds the enqueue pool with `createDbPool({ name: "jobs-enqueue" })`
 * and hands it to `makeWorkerUtils` as `pgPool`. This suite builds the same
 * composition in front of a black-hole proxy (`startBlackHoleProxy`, from the
 * connection plugin): forwarding on while graphile checks its migrations, then
 * off, so the insert's bytes vanish — the 2026-09-15 shape, where a job waited
 * 2.5 hours on a call no deadline covered.
 *
 * Against a throwaway database with the queue schema installed, so graphile's
 * migration check at `makeWorkerUtils` is a read and the insert has a table.
 *
 * Run: `./singularity test plugins/infra/plugins/jobs`
 * (requires the running embedded cluster — `./singularity build` first).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import net from "node:net";
import { sql } from "drizzle-orm";
import { makeWorkerUtils } from "graphile-worker";
import { z } from "zod";
import { readDatabaseConfig } from "@plugins/database/core";
import {
  createDbPool,
  queryDeadlineSink,
  type QueryDeadlineEvent,
} from "@plugins/database/plugins/connection/server";
import {
  QueryDeadlineExceededError,
  startBlackHoleProxy,
  type BlackHoleProxy,
} from "@plugins/database/plugins/connection/server/testing";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { executeOne } from "@plugins/database/plugins/sql-rows/core";
import { installQueueSchema } from "../../server/internal/queue-schema";

// Short, so the suite waits one bound rather than a minute.
const DEADLINE_MS = 1_500;

let t: TestDb;
let proxy: BlackHoleProxy;

function upstreamTarget(): net.NetConnectOpts {
  const { connection } = readDatabaseConfig();
  return connection.host.startsWith("/")
    ? { path: `${connection.host}/.s.PGSQL.${connection.port}` }
    : { host: connection.host, port: connection.port };
}

beforeAll(async () => {
  t = await createTestDb({ prefix: "jobs_enqueue_deadline" });
  await installQueueSchema(t.connectionString);
  proxy = await startBlackHoleProxy(upstreamTarget());
});

afterAll(async () => {
  // Destroys the proxied sockets, the abandoned connection's included, so the
  // throwaway database has no session left when it is dropped.
  await proxy.close();
  await new Promise((r) => setTimeout(r, 50));
  await t.drop();
});

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

describe("enqueue through the jobs-enqueue pool", () => {
  test("an insert that gets no reply rejects naming the jobs-enqueue pool", async () => {
    const { user } = readDatabaseConfig().connection;
    const { name: dbName } = await executeOne(t.db, {
      query: sql`SELECT current_database()::text AS name`,
      row: z.object({ name: z.string() }),
    });
    const pool = createDbPool({
      name: "jobs-enqueue",
      connectionString: `postgres://${user}@127.0.0.1:${proxy.port}/${dbName}`,
      max: 1,
      deadlineMs: DEADLINE_MS,
    });
    const events: QueryDeadlineEvent[] = [];
    queryDeadlineSink.register((event) => events.push(event));
    try {
      // Forwarding on: graphile connects and checks its migrations.
      const utils = await makeWorkerUtils({ pgPool: pool });
      try {
        proxy.setForwarding(false);
        // Deliberately graphile's raw insert, not `job.enqueue`: `enqueue`
        // reaches the process's own enqueue pool (this worktree's database),
        // which no proxy sits in front of. Exempted from `jobs:no-raw-addjob`
        // by path; the row lands nowhere (its bytes are dropped) on a throwaway
        // database.
        const err = await rejectionOf(
          utils.addJob("jobs.enqueue-deadline-test", {}),
        );
        expect(err).toBeInstanceOf(QueryDeadlineExceededError);
        const deadline = err as QueryDeadlineExceededError;
        expect(deadline.pool).toBe("jobs-enqueue");
        expect(deadline.phase).toBe("query");
        expect(deadline.deadlineMs).toBe(DEADLINE_MS);
        expect(
          events.some(
            (e) => e.kind === "deadline" && e.pool === "jobs-enqueue",
          ),
        ).toBe(true);
      } finally {
        await utils.release();
      }
    } finally {
      queryDeadlineSink.register(null);
      proxy.setForwarding(true);
      // The lost connection was detached from the pool, so this resolves.
      await pool.end();
    }
  });
});
