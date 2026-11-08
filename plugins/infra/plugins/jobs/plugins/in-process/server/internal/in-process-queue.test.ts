// `settleJobQueue` over the in-process queue — what a browser host's demo seed
// waits on between its steps. Rows run through a fake row runner, so the
// suite exercises the queue's own bookkeeping, not registered jobs.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { z } from "zod";
import { withHostServices } from "@plugins/framework/plugins/server-core/core/testing";
import {
  defineJob,
  jobAttemptSink,
  JobQueue,
  type JobAttemptEvent,
  type JobQueueImpl,
  type JobRowOutcome,
  type JobTaskPayload,
  type QueuedJob,
} from "@plugins/infra/plugins/jobs/server";
import {
  createInProcessQueue,
  missedTick,
  settleJobQueue,
} from "./in-process-queue";
import { parseCrontab } from "@plugins/infra/plugins/jobs/core";
import { memoryRowStore, type RowStore } from "./row-store";

const job = (name: string): QueuedJob => ({ name, hold: "instant" });
const payload = (jobName: string): JobTaskPayload => ({ jobName, input: {} });

type Handler = (attempt: number) => Promise<JobRowOutcome> | JobRowOutcome;

/** An in-process queue whose rows run `handlers[jobName]`, logging each run. */
function harness(
  handlers: Record<string, Handler>,
  store: RowStore = memoryRowStore(),
) {
  const ran: string[] = [];
  const queue = createInProcessQueue({
    store,
    runRow: async (p, meta) => {
      ran.push(`${p.jobName}#${meta.attempt}`);
      const handler = handlers[p.jobName];
      if (handler === undefined) throw new Error(`no handler for ${p.jobName}`);
      return handler(meta.attempt);
    },
  });
  return { queue, ran };
}

const started: JobQueueImpl[] = [];
async function start(queue: JobQueueImpl): Promise<void> {
  await queue.start();
  started.push(queue);
}
afterEach(async () => {
  for (const queue of started.splice(0)) await queue.stop();
});

const settle = (queue: JobQueueImpl) =>
  withHostServices([JobQueue.provide(queue)], () => settleJobQueue());

const completed: Handler = () => ({ kind: "completed" });

test("an empty queue settles at once", async () => {
  const { queue } = harness({});
  await start(queue);
  await settle(queue);
});

test("a row a run queues is followed before settle resolves (two-hop)", async () => {
  const { queue, ran } = harness({
    parent: async () => {
      // As events' dispatch does: the child is queued before this row is gone.
      await queue.enqueue(job("child"), payload("child"), {});
      return { kind: "completed" };
    },
    child: async () => {
      await queue.enqueue(job("grandchild"), payload("grandchild"), {});
      return { kind: "completed" };
    },
    grandchild: completed,
  });
  await start(queue);
  await queue.enqueue(job("parent"), payload("parent"), {});
  await settle(queue);
  expect(ran).toEqual(["parent#1", "child#1", "grandchild#1"]);
});

test("a future-dated, debounced row is fast-forwarded", async () => {
  const { queue, ran } = harness({ snapshot: completed });
  await start(queue);
  const inAnHour = () => new Date(Date.now() + 60 * 60 * 1000);
  // Two enqueues on one key collapse onto one row, due in an hour.
  await queue.enqueue(job("snapshot"), payload("snapshot"), {
    jobKey: "snapshot:page-1",
    runAt: inAnHour(),
  });
  await queue.enqueue(job("snapshot"), payload("snapshot"), {
    jobKey: "snapshot:page-1",
    runAt: inAnHour(),
  });
  await settle(queue);
  expect(ran).toEqual(["snapshot#1"]);
});

test("a debounced row a run queues mid-settle is fast-forwarded too", async () => {
  const { queue, ran } = harness({
    edit: async () => {
      await queue.enqueue(job("snapshot"), payload("snapshot"), {
        runAt: new Date(Date.now() + 4000),
      });
      return { kind: "completed" };
    },
    snapshot: completed,
  });
  await start(queue);
  await queue.enqueue(job("edit"), payload("edit"), {});
  await settle(queue);
  expect(ran).toEqual(["edit#1", "snapshot#1"]);
});

test("a row that ends dead rejects, naming the job and its error", async () => {
  const { queue } = harness({
    ok: completed,
    broken: () => ({
      kind: "failed",
      error: new Error("index out of date"),
      retry: false,
    }),
  });
  await start(queue);
  await queue.enqueue(job("ok"), payload("ok"), {});
  await queue.enqueue(job("broken"), payload("broken"), {});
  const pending = settle(queue);
  expect(pending).rejects.toThrow("broken");
  expect(pending).rejects.toThrow("index out of date");
});

test("a retrying row's backoff is fast-forwarded until it succeeds", async () => {
  // Backoff after attempts 1 and 2 is e¹ + e² ≈ 10 s, past the test timeout
  // unless fast-forwarded.
  const { queue, ran } = harness({
    flaky: (attempt) =>
      attempt < 3
        ? { kind: "failed", error: new Error("not yet"), retry: true }
        : { kind: "completed" },
  });
  await start(queue);
  await queue.enqueue(job("flaky"), payload("flaky"), { maxAttempts: 3 });
  await settle(queue);
  expect(ran).toEqual(["flaky#1", "flaky#2", "flaky#3"]);
});

test("a tx enqueue that commits just before settle is waited on", async () => {
  // `afterCommit` lands a row a turn later; settle's first macrotask yield
  // lets it in. Simulated with a row inserted from a setImmediate.
  const { queue, ran } = harness({ late: completed });
  await start(queue);
  setImmediate(() => {
    void queue.enqueue(job("late"), payload("late"), {});
  });
  await settle(queue);
  expect(ran).toEqual(["late#1"]);
});

test("settling a queue that is not started rejects", async () => {
  const { queue } = harness({ idle: completed });
  await queue.enqueue(job("idle"), payload("idle"), {});
  expect(settle(queue)).rejects.toThrow("not started");
});

test("settleJobQueue throws when the active queue is not the in-process one", async () => {
  const { queue } = harness({});
  const other: JobQueueImpl = { ...queue };
  expect(
    withHostServices([JobQueue.provide(other)], () => settleJobQueue()),
  ).rejects.toThrow("not the in-process queue");
});

// `onDead`: a run's end, told to its job once no attempt of it will come.
const deaths: {
  input: unknown;
  death: { cause: string; error: string };
  stateThen: string;
}[] = [];
/** The queue and row the hook reads back, to see what its effects would. */
let observe: { queue: JobQueueImpl; jobId: string } | null = null;
let told: () => void = () => {};
const nextDeath = () =>
  new Promise<void>((resolve) => {
    told = resolve;
  });
const MORTAL = "jobs.in-process-test-mortal";
const mortalJob = defineJob({
  name: MORTAL,
  description: "Test job.",
  hold: "instant",
  input: z.object({ id: z.string() }),
  event: z.never(),
  dedup: "none",
  run: () => {
    throw new Error("[jobs] run through the fake row runner only");
  },
  onDead: async ({ input, death }) => {
    // What the hook sets off must already read the run as over.
    const [row] =
      observe === null ? [] : await observe.queue.rows([observe.jobId]);
    deaths.push({ input, death, stateThen: row?.state ?? "removed" });
    told();
  },
});
beforeAll(async () => {
  await mortalJob.register();
});
const mortal = (id: string): JobTaskPayload => ({
  jobName: MORTAL,
  input: { id },
});

afterEach(() => {
  deaths.length = 0;
  observe = null;
});

test("a dead row tells its job, once it is dead", async () => {
  const { queue } = harness({
    [MORTAL]: () => ({
      kind: "failed",
      error: new Error("checkout lost"),
      retry: false,
    }),
  });
  await start(queue);
  const { jobId } = await queue.enqueue(job(MORTAL), mortal("a"), {});
  observe = { queue, jobId };
  const death = nextDeath();
  const pending = settle(queue);
  expect(pending).rejects.toThrow("checkout lost");
  await death;
  expect(deaths).toEqual([
    {
      input: { id: "a" },
      death: { cause: "failed", error: "checkout lost" },
      // Already dead — no longer in flight — when the hook ran.
      stateThen: "dead",
    },
  ]);
});

test("a row with a retry still to come tells nothing", async () => {
  const { queue } = harness({
    [MORTAL]: (attempt) =>
      attempt === 1
        ? { kind: "failed", error: new Error("blip"), retry: true }
        : { kind: "completed" },
  });
  await start(queue);
  await queue.enqueue(job(MORTAL), mortal("b"), {});
  await settle(queue);
  expect(deaths).toEqual([]);
});

test("a dead row's settle reaches the attempt seam, naming its row", async () => {
  const seen: JobAttemptEvent[] = [];
  jobAttemptSink.register((e) => {
    seen.push(e);
    return true;
  });
  try {
    const { queue } = harness({
      [MORTAL]: () => ({
        kind: "failed",
        error: new Error("checkout lost"),
        retry: false,
      }),
    });
    await start(queue);
    const { jobId } = await queue.enqueue(job(MORTAL), mortal("s"), {});
    const death = nextDeath();
    expect(settle(queue)).rejects.toThrow("checkout lost");
    await death;
    expect(seen).toEqual([
      {
        phase: "settled",
        jobName: MORTAL,
        jobId,
        outcome: { kind: "dead", cause: "failed", error: "checkout lost" },
      },
    ]);
  } finally {
    jobAttemptSink.register(null);
  }
});

test("a cancelled row tells its job it was cancelled", async () => {
  const { queue } = harness({ [MORTAL]: completed });
  // Not started: the row waits, so it can be removed.
  const { jobId } = await queue.enqueue(job(MORTAL), mortal("c"), {});
  await queue.cancel(jobId);
  expect(deaths.map((d) => [d.input, d.death.cause])).toEqual([
    [{ id: "c" }, "cancelled"],
  ]);
});

// ── Across a reload: the store outlives the queue ─────────────────────────────
// Two queues over one store stand for a host that ended and one that opened
// on its storage (the database-backed store itself: `durable.test.ts`).

test("a row queued before the host ended runs once the next one starts", async () => {
  const store = memoryRowStore();
  const before = harness({ edit: completed }, store);
  // Not started yet: the row waits — the tab closes before it runs.
  await before.queue.enqueue(job("edit"), payload("edit"), {
    runAt: new Date(Date.now() + 4000),
  });
  await before.queue.stop();
  const after = harness({ edit: completed }, store);
  await start(after.queue);
  await settle(after.queue);
  expect(after.ran).toEqual(["edit#1"]);
  expect((await store.load()).rows).toEqual([]);
});

const storedRow = (
  over: Partial<Parameters<RowStore["insert"]>[0]> & { id: string },
): Parameters<RowStore["insert"]>[0] => ({
  hold: "instant",
  payload: payload("edit"),
  jobKey: null,
  runAt: new Date(),
  attempts: 0,
  maxAttempts: 1,
  dead: false,
  lastError: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

test("an attempt the host ended counts: the next one runs as attempt 2", async () => {
  const store = memoryRowStore();
  await store.insert(storedRow({ id: "r1", attempts: 1, maxAttempts: 3 }));
  const { queue, ran } = harness({ edit: completed }, store);
  await start(queue);
  await settle(queue);
  expect(ran).toEqual(["edit#2"]);
});

test("a last attempt the host ended leaves the row dead, and tells its job", async () => {
  const store = memoryRowStore();
  await store.insert(
    storedRow({ id: "r2", payload: mortal("d"), attempts: 1, maxAttempts: 1 }),
  );
  const { queue, ran } = harness({ [MORTAL]: completed }, store);
  await start(queue);
  expect(ran).toEqual([]);
  const [row] = await queue.rows(["r2"]);
  expect(row?.state).toBe("dead");
  expect(deaths.map((d) => [d.input, d.death.cause])).toEqual([
    [{ id: "d" }, "worker-died"],
  ]);
  expect((await store.load()).rows.map((r) => r.dead)).toEqual([true]);
});

test("rows left holding one key collapse on load, the newest payload winning", async () => {
  const store = memoryRowStore();
  const t0 = Date.now();
  await store.insert(
    storedRow({
      id: "old",
      jobKey: "k",
      payload: { jobName: "edit", input: { v: 1 } },
      createdAt: new Date(t0 - 2000),
    }),
  );
  await store.insert(
    storedRow({
      id: "new",
      jobKey: "k",
      payload: { jobName: "edit", input: { v: 2 } },
      createdAt: new Date(t0 - 1000),
    }),
  );
  const inputs: unknown[] = [];
  const queue = createInProcessQueue({
    store,
    runRow: async (p) => {
      inputs.push(p.input);
      return { kind: "completed" };
    },
  });
  await start(queue);
  await settle(queue);
  expect(inputs).toEqual([{ v: 2 }]);
  expect((await store.load()).rows).toEqual([]);
});

// ── Missed ticks ──────────────────────────────────────────────────────────────

describe("missedTick", () => {
  const daily = parseCrontab("0 3 * * *");
  const at = (iso: string) => new Date(iso);
  test("the latest tick since the watermark, within the window", () => {
    expect(
      missedTick(
        daily,
        at("2026-11-01T12:00:00Z"),
        at("2026-11-04T10:00:00Z"),
        7 * 86_400_000,
      ),
    ).toEqual(at("2026-11-04T03:00:00Z"));
  });
  test("none when the next tick is still to come", () => {
    expect(
      missedTick(
        daily,
        at("2026-11-04T03:00:00Z"),
        at("2026-11-04T10:00:00Z"),
        7 * 86_400_000,
      ),
    ).toBeNull();
  });
  test("none older than the window", () => {
    expect(
      missedTick(
        daily,
        at("2026-11-01T12:00:00Z"),
        at("2026-11-04T10:00:00Z"),
        3_600_000,
      ),
    ).toBeNull();
  });
});

const DAILY = "jobs.in-process-test-daily";
const UNCAUGHT = "jobs.in-process-test-daily-no-catch-up";
beforeAll(async () => {
  for (const [name, catchUpWithinMs] of [
    [DAILY, 7 * 86_400_000],
    [UNCAUGHT, undefined],
  ] as const) {
    await defineJob({
      name,
      description: "Test job.",
      hold: "instant",
      input: z.object({}),
      event: z.never(),
      dedup: "singleton",
      schedule: { cron: "0 3 * * *", catchUpWithinMs },
      run: () => {
        throw new Error("[jobs] run through the fake row runner only");
      },
    }).register();
  }
});

test("a tick missed while no host ran runs once at schedule(), within catchUpWithinMs", async () => {
  const store = memoryRowStore();
  const longAgo = new Date(Date.now() - 3 * 86_400_000);
  await store.recordTick(DAILY, longAgo);
  await store.recordTick(UNCAUGHT, longAgo);
  const payloads: JobTaskPayload[] = [];
  const queue = createInProcessQueue({
    store,
    runRow: async (p) => {
      payloads.push(p);
      return { kind: "completed" };
    },
  });
  await start(queue);
  queue.schedule();
  await new Promise<void>((resolve) => {
    const off = queue.onActivity(() => {
      if (payloads.length > 0) {
        off();
        resolve();
      }
    });
  });
  await settle(queue);
  // The one with no catchUpWithinMs skips what it missed, as on the desktop.
  expect(payloads.map((p) => [p.jobName, p._cron?.backfilled])).toEqual([
    [DAILY, true],
  ]);
  const { lastExecutions } = await store.load();
  expect(lastExecutions.get(DAILY)!.getTime()).toBeGreaterThan(
    longAgo.getTime(),
  );
  expect(lastExecutions.get(UNCAUGHT)).toEqual(longAgo);
});

test("a schedule seen for the first time records now and catches up nothing", async () => {
  const store = memoryRowStore();
  const { queue, ran } = harness({}, store);
  await start(queue);
  queue.schedule();
  await settle(queue);
  await queue.stop();
  expect(ran).toEqual([]);
  const { lastExecutions } = await store.load();
  expect(lastExecutions.has(DAILY)).toBe(true);
});
