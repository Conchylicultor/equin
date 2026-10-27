import { describe, expect, setSystemTime, test } from "bun:test";
import {
  foldOpLines,
  liveTimes,
  type OpEvent,
  type OpSummary,
} from "@plugins/debug/plugins/profiling/plugins/op-log/core";
import type { SleepClockReading } from "@plugins/packages/plugins/sleep-clock/core";
import { createOpProfiler, type OpProfiler } from "./profiler";

// These tests drive `createOpProfiler` against an in-memory sink instead of the
// real `~/.equin/logs/op-log/op-log.jsonl`, so the profiler's record shape — its
// step clock and its sleep stamps — has a regression test that never touches
// the user's real op log.

const baseOpts = { opId: "op-test", branch: "feature", opSlug: "wt-test" };

/** The terminal's self-contained summary; throws when there is none. */
function summaryOf(records: OpEvent[]): OpSummary {
  const last = records.at(-1);
  if (last?.e !== "completed") throw new Error("no terminal event");
  return last.summary;
}

describe("createOpProfiler — injectable sink", () => {
  test("every phase lands on the injected sink, never the real op log", () => {
    const records: OpEvent[] = [];
    const p = createOpProfiler("build", {
      ...baseOpts,
      sink: (r) => records.push(r),
    });

    p.markRequested();
    p.markGranted();
    p.complete("success");
    p.write();

    expect(records.map((r) => r.e)).toEqual([
      "requested",
      "granted",
      "completed",
    ]);
    expect(summaryOf(records).outcome).toBe("success");
  });
});

describe("recordStep — one wall clock for every step", () => {
  // `recordStep` takes a WALL start (epoch ms), offset from the wall-clock
  // `grantedAt` — the same clock as `stepStart`/`stepEnd` and the op's whole
  // axis. It used to take a `performance.now()` reading, which pauses while
  // the machine sleeps: after a nap every later step sat too early.
  test("startMs is the wall delta from grantedAt", () => {
    const records: OpEvent[] = [];
    const T = Date.parse("2026-10-08T12:00:00.000Z");
    setSystemTime(new Date(T));
    try {
      const p = createOpProfiler("check", {
        ...baseOpts,
        sink: (r) => records.push(r),
      });
      p.markRequested();
      p.markGranted(); // grantedAt = T
      p.recordStep("early", 10, T + 200);
      p.recordStep("late", 10, T + 900);
      p.recordStep("rounds", 120, T + 500.4); // onto the integer-ms grid
      // A perf-clock start would be a tiny number, far before the grant.
      p.complete("success");
      p.write();
    } finally {
      setSystemTime();
    }

    expect(summaryOf(records).steps).toEqual([
      { name: "early", startMs: 200, durationMs: 10 },
      { name: "late", startMs: 900, durationMs: 10 },
      { name: "rounds", startMs: 500, durationMs: 120 },
    ]);
  });

  test("a step recorded before markGranted pins to 0 (no reference instant yet)", () => {
    const records: OpEvent[] = [];
    const p = createOpProfiler("check", {
      ...baseOpts,
      sink: (r) => records.push(r),
    });

    // No `markGranted` — there is no reference instant, so the offset is 0.
    p.recordStep("orphan", 30, Date.now());
    p.complete("success");
    p.write();

    expect(summaryOf(records).steps).toEqual([
      { name: "orphan", startMs: 0, durationMs: 30 },
    ]);
  });
});

describe("createOpProfiler — sleep stamps", () => {
  const T = Date.parse("2026-10-08T12:00:00.000Z");
  const HOUR = 3_600_000;
  const SLEPT = HOUR - 10_000;

  test("every event is stamped; the summary carries the sleeps and wall waits", () => {
    const records: OpEvent[] = [];
    let reading: SleepClockReading = {
      supported: true,
      boot: "boot-A",
      asleepMs: 1_000.4,
      wakeAtMs: null,
    };
    setSystemTime(new Date(T));
    try {
      const p = createOpProfiler("push", {
        ...baseOpts,
        sink: (r) => records.push(r),
        readSleep: () => reading,
      });
      p.markRequested();
      setSystemTime(new Date(T + 1_000));
      p.waitStart("push-mutex");
      // The lid closes for an hour, mid-queue.
      setSystemTime(new Date(T + HOUR + 1_000));
      reading = {
        supported: true,
        boot: "boot-A",
        asleepMs: 1_000.4 + SLEPT,
        wakeAtMs: T + HOUR,
      };
      p.markGranted(); // closes the wait
      setSystemTime(new Date(T + HOUR + 21_000));
      p.complete("success");
      p.write();
    } finally {
      setSystemTime();
    }

    for (const r of records) expect(r.sleep?.boot).toBe("boot-A");
    expect(records[0]!.sleep).toEqual({ boot: "boot-A", asleepMs: 1_000 });
    const s = summaryOf(records);
    expect(s.sleeps).toEqual([
      { startMs: 10_000, durationMs: SLEPT, approx: false },
    ]);
    expect(s.totalMs).toBe(HOUR + 21_000);
    expect(s.waits[0]).toMatchObject({ atMs: 1_000, wallMs: HOUR });

    // A reader folding the stream agrees with the writer.
    const state = foldOpLines(records).get("op-test")!;
    expect(state.sleeps).toEqual(s.sleeps!);
    const t = liveTimes(state, T + 9e9, null);
    expect(t).toEqual({
      elapsedMs: HOUR + 21_000,
      waitingMs: HOUR - SLEPT,
      workingMs: 21_000,
      asleepMs: SLEPT,
      openWaitMs: 0,
    });
  });

  test("an unsupported platform stamps nothing and records no sleep", () => {
    const records: OpEvent[] = [];
    const p = createOpProfiler("build", {
      ...baseOpts,
      sink: (r) => records.push(r),
      readSleep: () => ({ supported: false }),
    });
    p.markRequested();
    p.markGranted();
    p.complete("success");
    p.write();
    for (const r of records) expect("sleep" in r).toBe(false);
    expect(summaryOf(records).sleeps).toEqual([]);
  });
});

describe("createOpProfiler — every op kind", () => {
  // `OutcomeByKind` keys `complete()` per kind: the two grant-only kinds share
  // check's three-way vocabulary, and a push-shaped outcome is a type error.
  test("test and e2e run the full cycle with their own outcome vocabulary", () => {
    for (const kind of ["test", "e2e"] as const) {
      const records: OpEvent[] = [];
      const p = createOpProfiler(kind, {
        ...baseOpts,
        sink: (r) => records.push(r),
      });
      p.markRequested();
      p.grantHooks().onWaitStart?.();
      p.grantHooks().onAcquired?.(0);
      p.markGranted();
      p.complete("failed");
      p.write();
      const completed = summaryOf(records);
      expect(completed.kind).toBe(kind);
      expect(completed.outcome).toBe("failed");
      expect(completed.waits.map((w) => w.kind)).toEqual(["host-grant"]);
    }
  });

  test("a push-only outcome is rejected on a test op at the type level", () => {
    const p = createOpProfiler("test", { ...baseOpts, sink: () => {} });
    // @ts-expect-error — "failed_rebase" belongs to OutcomeByKind["push"] only.
    p.complete("failed_rebase");
  });
});

describe("createOpProfiler — the v2 event stream", () => {
  const run = (drive: (p: OpProfiler<"build">) => void): OpEvent[] => {
    const records: OpEvent[] = [];
    const p = createOpProfiler("build", {
      ...baseOpts,
      buildId: "b-1",
      sink: (r) => records.push(r),
    });
    drive(p);
    return records;
  };

  test("change-only deltas with a strictly increasing per-op seq", () => {
    const records = run((p) => {
      p.markRequested();
      p.waitStart("build-lock");
      p.markGranted();
      p.waitStart("duress-valve", "loadRatio");
      p.waitEnd("fail-open");
      p.requeue();
      p.grantHooks().onWaitStart?.();
      p.grantHooks().onAcquired?.(5);
      p.complete("success");
      p.write();
      p.write(); // idempotent
    });
    expect(records.map((r) => r.e)).toEqual([
      "requested",
      "wait-start",
      "wait-end", // build-lock, closed by markGranted
      "granted",
      "wait-start",
      "wait-end",
      "requeue",
      "wait-start",
      "wait-end",
      "completed",
    ]);
    expect(records.map((r) => r.seq)).toEqual(records.map((_, i) => i + 1));
    for (const r of records) {
      expect(r.v).toBe(2);
      expect(r.opId).toBe("op-test");
      expect(r.t).toBeGreaterThanOrEqual(0);
    }
    const req = records[0]!;
    expect(req.e === "requested" && req.pid).toBe(process.pid);

    const valveEnd = records[5]!;
    expect(valveEnd.e === "wait-end" && valveEnd.result).toBe("fail-open");
    expect(valveEnd.e === "wait-end" && valveEnd.reason).toBe("loadRatio");
    // Waits after the requeue carry the new cycle.
    const grantStart = records[7]!;
    expect(grantStart.e === "wait-start" && grantStart.cycle).toBe(1);

    const s = summaryOf(records);
    expect(s.kind).toBe("build");
    expect(s.buildId).toBe("b-1");
    expect(s.pid).toBe(process.pid);
    expect(s.grantedAt).not.toBeNull();
    expect(s.interrupted).toBe(false);
    expect(s.waits.map((w) => [w.kind, w.cycle, w.result])).toEqual([
      ["build-lock", 0, "acquired"],
      ["duress-valve", 0, "fail-open"],
      ["host-grant", 1, "acquired"],
    ]);
  });

  test("a fast-path grant emits ONE self-contained wait-end, no wait-start", () => {
    const records = run((p) => {
      p.markRequested();
      p.grantHooks().onAcquired?.(250);
      p.grantHooks().onAcquired?.(0); // zero-width: nothing recorded
    });
    expect(records.map((r) => r.e)).toEqual(["requested", "wait-end"]);
    const end = records[1]!;
    if (end.e !== "wait-end") throw new Error("expected wait-end");
    expect(end.wait).toBe("host-grant");
    expect(end.durationMs).toBe(250);
    expect(end.result).toBe("acquired");
    expect(end.cycle).toBe(0);
  });

  test("an event before markRequested lands the identity first", () => {
    const records = run((p) => {
      p.waitStart("push-mutex");
      p.markRequested(); // already written — no second `requested`
    });
    expect(records.map((r) => r.e)).toEqual(["requested", "wait-start"]);
  });

  test("an op killed mid-wait: the terminal closes the wait as aborted, ungranted", () => {
    const records = run((p) => {
      p.markRequested();
      p.waitStart("host-grant");
      p.write();
    });
    const s = summaryOf(records);
    expect(s.outcome).toBe("error");
    expect(s.grantedAt).toBeNull();
    expect(s.holdMs).toBe(0);
    expect(s.waits.map((w) => w.result)).toEqual(["aborted"]);
  });

  test("wait() closes acquired on return and aborted on throw", async () => {
    const records = run(() => {});
    const p = createOpProfiler("build", {
      ...baseOpts,
      sink: (r) => records.push(r),
    });
    await p.wait("build-lock", async () => 1);
    await p
      .wait("build-lock", async () => {
        throw new Error("boom");
      })
      .catch((err: unknown) => {
        if (!(err instanceof Error) || err.message !== "boom") throw err;
      });
    const results = records.flatMap((r) =>
      r.e === "wait-end" ? [r.result] : [],
    );
    expect(results).toEqual(["acquired", "aborted"]);
  });
});
