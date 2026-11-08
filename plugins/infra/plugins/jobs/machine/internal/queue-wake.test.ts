/**
 * Real-DB suite for the queue wake (queue-wake.ts): graphile runners with the
 * poll switched off (`NO_POLL_INTERVAL_MS`), on a throwaway database, must
 * still run every row no insert announces — a future `run_at`, a retry's
 * backoff, a row behind a serial lane another runner released.
 *
 * Run: `./equin test plugins/infra/plugins/jobs`
 * (requires the running embedded cluster — `./equin build` first).
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { EventEmitter } from "node:events";
import {
  run,
  type Runner,
  type TaskList,
  type WorkerEvents,
} from "graphile-worker";
import { Pool } from "pg";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { taskFor } from "../../core/hold";
import { installQueueSchema } from "../../server/internal/queue-schema";
import { queryQueueDue } from "./introspection";
import { createQueueWake, NO_POLL_INTERVAL_MS } from "./queue-wake";
import { attachSlotLedger, clearSlotLedger } from "./slot-ledger";

// Two of the plugin's own task identifiers: `queryQueueDue` reads only those.
const TASK_A = taskFor("instant");
const TASK_B = taskFor("seconds");

let t: TestDb;
let pool: Pool;

beforeAll(async () => {
  t = await createTestDb({ prefix: "queue_wake_test" });
  await installQueueSchema(t.connectionString);
  pool = new Pool({ connectionString: t.connectionString, max: 8 });
  pool.on("error", (err) => {
    throw err;
  });
});

afterAll(async () => {
  await pool.end();
  await t.drop();
});

afterEach(async () => {
  clearSlotLedger();
  await pool.query(`DELETE FROM graphile_worker._private_jobs`);
});

interface Started {
  runners: Runner[];
  stop: () => Promise<void>;
}

/** Start one runner per task list, the poll off, with (or without) a wake. */
async function startRunners(
  taskLists: TaskList[],
  opts: { wake: boolean },
): Promise<Started> {
  const wake = createQueueWake({ readDue: () => queryQueueDue(t.db) });
  const detaches: (() => void)[] = [];
  const runners: Runner[] = [];
  for (const [i, taskList] of taskLists.entries()) {
    const events: WorkerEvents = new EventEmitter();
    detaches.push(
      attachSlotLedger(`r${i}`, events, { listenInserts: i === 0 }),
    );
    if (opts.wake) {
      detaches.push(
        wake.attach(`r${i}`, Object.keys(taskList), events, {
          listenInserts: i === 0,
        }),
      );
    }
    runners.push(
      await run(
        {
          pgPool: pool,
          concurrency: 2,
          noHandleSignals: true,
          taskList,
          events,
          preset: {
            worker: {
              completeJobBatchDelay: 0,
              failJobBatchDelay: 0,
              pollInterval: NO_POLL_INTERVAL_MS,
            },
          },
        },
        undefined,
        [],
      ),
    );
  }
  return {
    runners,
    stop: async () => {
      await Promise.all(runners.map((r) => r.stop()));
      for (const d of detaches) d();
    },
  };
}

async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return cond();
}

describe("queue wake", () => {
  test("without the wake, a future-dated row is never fetched (the poll is off)", async () => {
    let ran = false;
    const s = await startRunners([{ [TASK_A]: () => void (ran = true) }], {
      wake: false,
    });
    try {
      await s.runners[0]!.addJob(
        TASK_A,
        {},
        { runAt: new Date(Date.now() + 500) },
      );
      expect(await until(() => ran, 3_000)).toBe(false);
    } finally {
      await s.stop();
    }
  }, 30_000);

  test("a future-dated row runs when its run_at comes due", async () => {
    let ranAt: number | null = null;
    const s = await startRunners(
      [{ [TASK_A]: () => void (ranAt = Date.now()) }],
      {
        wake: true,
      },
    );
    try {
      const runAt = Date.now() + 1_000;
      await s.runners[0]!.addJob(TASK_A, {}, { runAt: new Date(runAt) });
      expect(await until(() => ranAt !== null, 5_000)).toBe(true);
      expect(ranAt!).toBeGreaterThanOrEqual(runAt - 50);
      expect(ranAt! - runAt).toBeLessThan(1_000);
    } finally {
      await s.stop();
    }
  }, 30_000);

  test("a failed attempt's retry runs after its backoff", async () => {
    let attempts = 0;
    const s = await startRunners(
      [
        {
          [TASK_A]: () => {
            attempts++;
            if (attempts === 1) throw new Error("first attempt fails");
          },
        },
      ],
      { wake: true },
    );
    try {
      await s.runners[0]!.addJob(TASK_A, {}, { maxAttempts: 2 });
      // graphile's backoff after attempt 1 is exp(1) ≈ 2.7 s.
      expect(await until(() => attempts === 2, 8_000)).toBe(true);
    } finally {
      await s.stop();
    }
  }, 30_000);

  test("a row behind a lane another runner released runs", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let aStarted = false;
    let bRan = false;
    const s = await startRunners(
      [
        {
          [TASK_A]: async () => {
            aStarted = true;
            await gate;
          },
        },
        { [TASK_B]: () => void (bRan = true) },
      ],
      { wake: true },
    );
    try {
      await s.runners[0]!.addJob(TASK_A, {}, { queueName: "lane" });
      expect(await until(() => aStarted, 5_000)).toBe(true);
      // Inserted while the lane is held: its notification finds nothing to
      // fetch, and only runner 1 serves it — runner 0, whose worker frees the
      // lane, cannot see it.
      await s.runners[0]!.addJob(TASK_B, {}, { queueName: "lane" });
      expect(await until(() => bRan, 500)).toBe(false);
      release();
      expect(await until(() => bRan, 3_000)).toBe(true);
    } finally {
      release();
      await s.stop();
    }
  }, 30_000);
});
