// `settleJobQueue` over the in-process queue — what a browser host's demo seed
// waits on between its steps. Rows run through a fake row runner, so the
// suite exercises the queue's own bookkeeping, not registered jobs.

import { afterEach, expect, test } from "bun:test";
import { withHostServices } from "@plugins/framework/plugins/server-core/core/testing";
import {
  JobQueue,
  type JobQueueImpl,
  type JobRowOutcome,
  type JobTaskPayload,
  type QueuedJob,
} from "@plugins/infra/plugins/jobs/server";
import { createMemoryQueue, settleJobQueue } from "./memory-queue";

const job = (name: string): QueuedJob => ({ name, hold: "instant" });
const payload = (jobName: string): JobTaskPayload => ({ jobName, input: {} });

type Handler = (attempt: number) => Promise<JobRowOutcome> | JobRowOutcome;

/** An in-process queue whose rows run `handlers[jobName]`, logging each run. */
function harness(handlers: Record<string, Handler>) {
  const ran: string[] = [];
  const queue = createMemoryQueue(async (p, meta) => {
    ran.push(`${p.jobName}#${meta.attempt}`);
    const handler = handlers[p.jobName];
    if (handler === undefined) throw new Error(`no handler for ${p.jobName}`);
    return handler(meta.attempt);
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

/** The error `p` rejects with — failing the test if it resolves. */
async function rejection(p: Promise<unknown>): Promise<Error> {
  const outcome = await p.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(outcome instanceof Error)) throw new Error("expected a rejection");
  return outcome;
}

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
  const { message } = await rejection(settle(queue));
  expect(message).toContain("broken");
  expect(message).toContain("index out of date");
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
  expect((await rejection(settle(queue))).message).toContain("not started");
});

test("settleJobQueue throws when the active queue is not the in-process one", async () => {
  const { queue } = harness({});
  const other: JobQueueImpl = { ...queue };
  const err = await rejection(
    withHostServices([JobQueue.provide(other)], () => settleJobQueue()),
  );
  expect(err.message).toContain("not the in-process queue");
});
