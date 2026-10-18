/**
 * The slot ledger, driven by a fake graphile emitter — no database, no runner.
 *
 * What it pins: a slot enters on `job:start` and leaves ONLY on graphile's own
 * `job:complete` / `worker:fatalError` (the events that fire after the outcome
 * is written); busy slots are attributed to the runner whose emitter heard
 * them; `jobs:insert` is announced by the one runner told to listen; and the
 * pickup ring keeps a bounded, windowed sample with nearest-rank percentiles.
 *
 * Run: `./singularity test plugins/infra/plugins/jobs`
 */

import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { Job, Worker, WorkerEvents } from "graphile-worker";
import { setErrorReporter } from "@plugins/framework/plugins/server-core/core";
import { LEGACY_JOB_TASK, taskFor } from "../../core/hold";
import {
  PICKUP_SAMPLE_CAP,
  PICKUP_WINDOW_MS,
  attachSlotLedger,
  clearSlotLedger,
  emitQueueActivity,
  getOccupiedSlots,
  getPickupStats,
  onQueueActivity,
} from "./slot-ledger";

const T0 = Date.UTC(2026, 8, 11, 12, 0, 0);

function fakeWorker(workerId: string): Worker {
  return { workerId } as Worker;
}

function fakeJob(over: {
  id: string;
  task?: string;
  jobName?: string;
  runAt?: number;
  lockedAt?: number;
  attempts?: number;
  queueId?: number | null;
}): Job {
  return {
    id: over.id,
    task_identifier: over.task ?? taskFor("instant"),
    payload: { jobName: over.jobName ?? "test.job", input: {} },
    run_at: new Date(over.runAt ?? T0),
    locked_at: new Date(over.lockedAt ?? T0 + 5),
    attempts: over.attempts ?? 1,
    job_queue_id: over.queueId ?? null,
  } as unknown as Job;
}

function runner(
  id: string,
  opts: { listenInserts: boolean } = { listenInserts: false },
) {
  const events: WorkerEvents = new EventEmitter();
  const detach = attachSlotLedger(id, events, opts);
  return {
    events,
    detach,
    start(workerId: string, job: Job) {
      events.emit("job:start", { worker: fakeWorker(workerId), job });
    },
    complete(workerId: string, job: Job) {
      events.emit("job:complete", {
        worker: fakeWorker(workerId),
        job,
        error: null,
      });
    },
    fatal(workerId: string) {
      events.emit("worker:fatalError", {
        worker: fakeWorker(workerId),
        error: new Error("release failed"),
        jobError: null,
      });
    },
    notify(channel: string) {
      events.emit("pool:listen:notification", {
        message: { channel, payload: "{}" },
      } as never);
    },
  };
}

const detaches: (() => void)[] = [];
function attach(...args: Parameters<typeof runner>) {
  const r = runner(...args);
  detaches.push(r.detach);
  return r;
}

afterEach(() => {
  for (const d of detaches.splice(0)) d();
  clearSlotLedger();
});

describe("occupancy", () => {
  test("start records the slot; complete frees it", () => {
    const wide = attach("wide");
    const job = fakeJob({
      id: "42",
      task: taskFor("minutes"),
      jobName: "backup.run",
      runAt: T0,
      lockedAt: T0 + 250,
      attempts: 2,
    });
    wide.start("w1", job);
    expect(getOccupiedSlots()).toEqual([
      {
        workerId: "w1",
        runnerId: "wide",
        jobId: "42",
        jobName: "backup.run",
        hold: "minutes",
        runAt: T0,
        lockedAt: T0 + 250,
        attempt: 2,
      },
    ]);
    wide.complete("w1", job);
    expect(getOccupiedSlots()).toEqual([]);
  });

  test("worker:fatalError frees the slot", () => {
    const floor = attach("floor");
    floor.start("w1", fakeJob({ id: "1" }));
    floor.fatal("w1");
    expect(getOccupiedSlots()).toEqual([]);
  });

  test("the legacy task reads as minutes", () => {
    const wide = attach("wide");
    wide.start("w1", fakeJob({ id: "1", task: LEGACY_JOB_TASK }));
    expect(getOccupiedSlots()[0]!.hold).toBe("minutes");
  });

  test("a payload with no jobName reads as (unknown)", () => {
    const floor = attach("floor");
    const job = fakeJob({ id: "1" });
    (job as { payload: unknown }).payload = { input: {} };
    floor.start("w1", job);
    expect(getOccupiedSlots()[0]!.jobName).toBe("(unknown)");
  });

  test("busy slots are attributed to the runner whose emitter heard them", () => {
    const floor = attach("floor");
    const mid = attach("mid");
    const wide = attach("wide");
    floor.start("f1", fakeJob({ id: "1" }));
    floor.start("f2", fakeJob({ id: "2" }));
    mid.start("m1", fakeJob({ id: "3", task: taskFor("seconds") }));
    wide.start("x1", fakeJob({ id: "4", task: taskFor("minutes") }));
    wide.start("x2", fakeJob({ id: "5", task: taskFor("minutes") }));
    wide.complete("x1", fakeJob({ id: "4", task: taskFor("minutes") }));

    const busy = new Map<string, number>();
    for (const s of getOccupiedSlots()) {
      busy.set(s.runnerId, (busy.get(s.runnerId) ?? 0) + 1);
    }
    expect(Object.fromEntries(busy)).toEqual({ floor: 2, mid: 1, wide: 1 });
  });

  test("detach stops the ledger hearing that runner", () => {
    const floor = runner("floor");
    floor.detach();
    floor.start("w1", fakeJob({ id: "1" }));
    expect(getOccupiedSlots()).toEqual([]);
  });

  test("clearSlotLedger forgets slots and samples", () => {
    const floor = attach("floor");
    floor.start("w1", fakeJob({ id: "1" }));
    clearSlotLedger();
    expect(getOccupiedSlots()).toEqual([]);
    expect(getPickupStats().instant.count).toBe(0);
  });

  test("a job row without a Date lock stamp is reported, never recorded as NaN", () => {
    const reported: string[] = [];
    setErrorReporter((r) => reported.push(r.message));
    const originalError = console.error;
    console.error = () => {};
    try {
      const floor = attach("floor");
      const job = fakeJob({ id: "1" });
      (job as { locked_at: unknown }).locked_at = null;
      floor.start("w1", job);
      expect(getOccupiedSlots()).toEqual([]);
      expect(reported).toHaveLength(1);
      expect(reported[0]).toContain("locked_at");
    } finally {
      console.error = originalError;
      setErrorReporter(() => {});
    }
  });
});

describe("activity", () => {
  test("start, complete and fatalError each announce", () => {
    const floor = attach("floor");
    let n = 0;
    const off = onQueueActivity(() => n++);
    floor.start("w1", fakeJob({ id: "1" }));
    floor.complete("w1", fakeJob({ id: "1" }));
    floor.start("w2", fakeJob({ id: "2" }));
    floor.fatal("w2");
    off();
    expect(n).toBe(4);
  });

  test("jobs:insert is announced by the listening runner only", () => {
    const floor = attach("floor", { listenInserts: false });
    const wide = attach("wide", { listenInserts: true });
    let n = 0;
    const off = onQueueActivity(() => n++);
    floor.notify("jobs:insert");
    wide.notify("jobs:insert");
    wide.notify("worker:migrate");
    off();
    expect(n).toBe(1);
  });

  test("unsubscribe stops delivery", () => {
    let n = 0;
    const off = onQueueActivity(() => n++);
    emitQueueActivity();
    off();
    emitQueueActivity();
    expect(n).toBe(1);
  });

  test("a throwing listener is reported and does not stop the others or reach graphile", () => {
    const reported: string[] = [];
    setErrorReporter((r) => reported.push(r.message));
    const originalError = console.error;
    console.error = () => {};
    let reached = 0;
    const offBad = onQueueActivity(() => {
      throw new Error("listener boom");
    });
    const offGood = onQueueActivity(() => reached++);
    try {
      const floor = attach("floor");
      // Would throw out of `emit` — i.e. into graphile's worker loop — if the
      // ledger re-threw.
      expect(() => floor.start("w1", fakeJob({ id: "1" }))).not.toThrow();
      expect(reached).toBe(1);
      expect(getOccupiedSlots()).toHaveLength(1);
      expect(reported).toHaveLength(1);
      expect(reported[0]).toContain("listener boom");
    } finally {
      offBad();
      offGood();
      console.error = originalError;
      setErrorReporter(() => {});
    }
  });
});

describe("pickup stats", () => {
  test("an empty window is count 0 with null percentiles, not 0 ms", () => {
    expect(getPickupStats()).toEqual({
      instant: { count: 0, p50Ms: null, p95Ms: null, maxMs: null },
      seconds: { count: 0, p50Ms: null, p95Ms: null, maxMs: null },
      minutes: { count: 0, p50Ms: null, p95Ms: null, maxMs: null },
    });
  });

  test("nearest-rank percentiles per class, from lockedAt − runAt", () => {
    const floor = attach("floor");
    const wide = attach("wide");
    // instant delays 1..100 ms.
    for (let i = 1; i <= 100; i++) {
      const job = fakeJob({ id: String(i), runAt: T0, lockedAt: T0 + i });
      floor.start(`f${i}`, job);
      floor.complete(`f${i}`, job);
    }
    wide.start(
      "x1",
      fakeJob({
        id: "m1",
        task: taskFor("minutes"),
        runAt: T0,
        lockedAt: T0 + 30_000,
      }),
    );

    const stats = getPickupStats();
    expect(stats.instant).toEqual({
      count: 100,
      p50Ms: 50,
      p95Ms: 95,
      maxMs: 100,
    });
    expect(stats.minutes).toEqual({
      count: 1,
      p50Ms: 30_000,
      p95Ms: 30_000,
      maxMs: 30_000,
    });
    expect(stats.seconds.count).toBe(0);
  });

  test("a row in a serial lane is not sampled — it may have waited for its lane", () => {
    const floor = attach("floor");
    floor.start("w1", fakeJob({ id: "1", lockedAt: T0 + 90_000, queueId: 7 }));
    expect(getOccupiedSlots()).toHaveLength(1);
    expect(getPickupStats().instant.count).toBe(0);
  });

  test("samples older than the window are evicted", () => {
    const floor = attach("floor");
    floor.start("w1", fakeJob({ id: "1", lockedAt: T0 + 10 }));
    const now = Date.now();
    expect(getPickupStats(now).instant.count).toBe(1);
    expect(getPickupStats(now + PICKUP_WINDOW_MS + 1).instant).toEqual({
      count: 0,
      p50Ms: null,
      p95Ms: null,
      maxMs: null,
    });
  });

  test("the ring keeps the newest PICKUP_SAMPLE_CAP samples", () => {
    const floor = attach("floor");
    const extra = 10;
    for (let i = 1; i <= PICKUP_SAMPLE_CAP + extra; i++) {
      const job = fakeJob({ id: String(i), runAt: T0, lockedAt: T0 + i });
      floor.start("w1", job);
      floor.complete("w1", job);
    }
    const stats = getPickupStats().instant;
    expect(stats.count).toBe(PICKUP_SAMPLE_CAP);
    // The first `extra` delays (1..10 ms) were the oldest and were dropped.
    expect(stats.maxMs).toBe(PICKUP_SAMPLE_CAP + extra);
    expect(stats.p50Ms).toBe(extra + PICKUP_SAMPLE_CAP / 2);
  });
});
