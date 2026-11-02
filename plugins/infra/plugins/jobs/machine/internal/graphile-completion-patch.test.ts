/**
 * Real-DB regression suite for `patches/graphile-worker@0.18.0.patch`, run
 * through a real graphile runner with the batch delay `startWorkers` sets.
 *
 * 2026-11-01: a multi-row completion DELETE deadlocked against cron's multi-row
 * `add_job` transaction, graphile's batch retry never ran (a stray `break`), and
 * the one `40P01` stopped main's `wide` runner and the cron schedule with it.
 *
 * Run: `./equin test plugins/infra/plugins/jobs`
 * (requires the running embedded cluster — `./equin build` first).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { run, type Runner } from "graphile-worker";
import pg, { Client, Pool } from "pg";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { installQueueSchema } from "../../server/internal/queue-schema";

let t: TestDb;
let admin: Client;

beforeAll(async () => {
  t = await createTestDb({ prefix: "graphile_completion_patch_test" });
  await installQueueSchema(t.connectionString);
  admin = new Client({ connectionString: t.connectionString });
  await admin.connect();
});

afterAll(async () => {
  await admin.end();
  await t.drop();
});

/** A pool whose clients record every job-row DELETE and fail the first `faults`
 * of them with Postgres' deadlock code. */
function faultyPool(faults: number): { pool: Pool; deletes: string[] } {
  const deletes: string[] = [];
  let remaining = faults;
  class FaultyClient extends pg.Client {
    override query(...args: unknown[]): never {
      const first = args[0] as { text?: string } | string;
      const text = typeof first === "string" ? first : (first?.text ?? "");
      if (text.includes("delete from") && text.includes("_private_jobs")) {
        deletes.push(text);
        if (remaining > 0) {
          remaining--;
          return Promise.reject(
            Object.assign(new Error("deadlock detected"), { code: "40P01" }),
          ) as never;
        }
      }
      return (super.query as (...a: unknown[]) => never)(...args);
    }
  }
  const pool = new Pool({
    connectionString: t.connectionString,
    Client: FaultyClient,
    max: 8,
  });
  pool.on("error", (err) => {
    throw err;
  });
  return { pool, deletes };
}

async function withRunner<T>(
  pool: Pool,
  task: (runner: Runner) => Promise<T>,
  taskList: Record<string, () => Promise<void> | void>,
): Promise<T> {
  const runner = await run(
    {
      pgPool: pool,
      concurrency: 4,
      noHandleSignals: true,
      taskList,
      preset: { worker: { completeJobBatchDelay: 0, failJobBatchDelay: 0 } },
    },
    undefined,
    [],
  );
  try {
    return await task(runner);
  } finally {
    await runner.stop();
    await pool.end();
  }
}

async function jobRowCount(): Promise<number> {
  const { rows } = await admin.query<{ n: string }>(
    `SELECT count(*) AS n FROM graphile_worker._private_jobs`,
  );
  return Number(rows[0]!.n);
}

async function untilJobRowsAre(n: number): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if ((await jobRowCount()) === n) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`job rows never reached ${n}: ${await jobRowCount()}`);
}

describe("graphile completion patch", () => {
  test("a deadlock on a completion is retried: the runner lives and the row goes", async () => {
    const { pool, deletes } = faultyPool(1);
    await withRunner(
      pool,
      async (runner) => {
        let died = false;
        void runner.promise.then(() => {
          died = true;
        });
        await runner.addJob("patch_retry", {});
        await untilJobRowsAre(0);
        expect(deletes.length).toBe(2);
        expect(died).toBe(false);
      },
      { patch_retry: () => undefined },
    );
  }, 30_000);

  test("jobs finishing together are deleted one row per statement", async () => {
    const { pool, deletes } = faultyPool(0);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let started = 0;
    await withRunner(
      pool,
      async (runner) => {
        for (let i = 0; i < 4; i++) await runner.addJob("patch_batch", {});
        for (let i = 0; i < 500 && started < 4; i++) {
          await new Promise((r) => setTimeout(r, 10));
        }
        expect(started).toBe(4);
        release();
        await untilJobRowsAre(0);
        expect(deletes.length).toBe(4);
        expect(deletes.some((text) => text.includes("unnest"))).toBe(false);
      },
      {
        patch_batch: async () => {
          started++;
          await gate;
        },
      },
    );
  }, 30_000);
});
