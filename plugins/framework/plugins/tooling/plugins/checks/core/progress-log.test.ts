import { describe, expect, test } from "bun:test";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/core";
import type {
  StackSample,
  StackSampler,
} from "@plugins/infra/plugins/stack-sampler/core";
import {
  reconstructRuns,
  startProgressRun,
  type ProgressRecord,
} from "./progress-log";
import type { StallReportSink } from "./stall-report";
import { STALL_MS } from "./thread-watch";

// Never the host-global sink, never the real sampler: records go to an array,
// samples come from a fake. `bun test` runs every file in one process, and the
// sampler has one owner per process — a test claim would decide whether
// health-monitor's own claim throws.
function recorder(): {
  records: ProgressRecord[];
  write: (r: ProgressRecord) => void;
} {
  const records: ProgressRecord[] = [];
  return { records, write: (r) => records.push(r) };
}

const IN_CHECK_X: StackSample = {
  timestamp: 0,
  frames: [
    {
      name: "spin",
      // Under the real repo root: the watch attributes against it by default.
      sourceURL: `${REPO_ROOT}/plugins/x/check/index.ts`,
      line: 3,
      column: 1,
      category: "JIT",
    },
  ],
  activity: null,
};

/**
 * Never the host-global outbox — main would drain a test's entry into a real
 * report. These suites' stalls stay under the report threshold anyway; the
 * thresholds are stall-report.test.ts's subject.
 */
const noReports: StallReportSink = {
  file: async () => ({ outcome: "refused", pending: 0 }),
  mergeBase: async () => ({ ok: false, reason: "test" }),
};

function fakeSampler(batch: StackSample[]): StackSampler {
  return { drain: () => batch };
}

/** Hold the thread without yielding — what a stall IS. */
function block(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    // spin
  }
}

describe("startProgressRun", () => {
  test("a run closed at an early exit still writes `thread`, just before `done`", () => {
    const { records, write } = recorder();
    const run = startProgressRun(
      { scope: null, requested: ["no-such-check"] },
      { write, sampler: fakeSampler([]), reports: noReports },
    );
    const summary = run.finish(false);
    expect(records.map((r) => r.phase)).toEqual(["run", "thread", "done"]);
    expect(summary.stallCount).toBe(0);

    const [progress] = reconstructRuns(records);
    expect(progress?.thread).toMatchObject({ stallCount: 0, stalledMs: 0 });
    // No samples drained (an empty sampler) → every kind is zero-filled, never
    // dropped — but this run went through the REAL `process.cpuUsage()`, so
    // `cpu` itself is only known to be a non-negative number, not exactly zero.
    expect(progress?.thread?.kinds).toEqual({
      "blocking-io": 0,
      process: 0,
      "module-load": 0,
      cpu: 0,
      native: 0,
    });
    expect(progress?.thread?.cpu?.userMs).toBeGreaterThanOrEqual(0);
    expect(progress?.thread?.cpu?.systemMs).toBeGreaterThanOrEqual(0);
    expect(progress?.done?.allOk).toBe(false);
  });

  test("a block the late tick never saw is still a stall: `end.stalledMs` counts the open gap, `finish()` records it", () => {
    const { records, write } = recorder();
    const run = startProgressRun(
      { scope: null, requested: null },
      { write, sampler: fakeSampler([IN_CHECK_X]), reports: noReports },
    );
    run.checkStarted("x");
    const wallStart = performance.now();
    block(STALL_MS + 200);
    // Settles in the same turn the block ends — before any tick has run.
    run.checkEnded(
      "x",
      Math.round(performance.now() - wallStart),
      true,
      false,
      0,
      null,
    );
    const summary = run.finish(true);

    expect(records.map((r) => r.phase)).toEqual([
      "run",
      "start",
      "end",
      "stall",
      "thread",
      "done",
    ]);
    const end = records.find((r) => r.phase === "end");
    expect(end?.phase === "end" && end.stalledMs).toBeGreaterThanOrEqual(
      STALL_MS,
    );

    expect(summary.stallCount).toBe(1);
    expect(summary.stallOwners[0]?.owner).toBe("check x");
    const [progress] = reconstructRuns(records);
    expect(progress?.stalls).toHaveLength(1);
    expect(progress?.stalls[0]?.running).toEqual(["x"]);
    expect(progress?.thread?.stallCount).toBe(1);
    expect(progress?.completed[0]?.stalledMs).toBeGreaterThanOrEqual(STALL_MS);
    // IN_CHECK_X's `spin` frame has a source and matches no named set → cpu.
    // Every sample this stall drained lands there, and nowhere else.
    const stall = progress?.stalls[0];
    if (!stall) throw new Error("expected one stall");
    expect(stall.kinds).toEqual({
      "blocking-io": 0,
      process: 0,
      "module-load": 0,
      cpu: stall.samples,
      native: 0,
    });
    expect(progress?.stalls[0]?.leaves?.[0]?.leaf).toBe(
      "spin @ plugins/x/check/index.ts:3",
    );
    // A real `process.cpuUsage()` delta over a real busy-spin: not pinned to
    // an exact number (scheduling noise), just that it is a real reading.
    expect(progress?.stalls[0]?.cpu?.userMs).toBeGreaterThanOrEqual(0);
    expect(progress?.thread?.cpu?.userMs).toBeGreaterThanOrEqual(0);
  }, 10_000);
});

describe("reconstructRuns", () => {
  const base = { runId: "r1", pid: 1, worktree: "wt" };
  const at = (s: number): string =>
    new Date(Date.UTC(2026, 8, 15, 0, 0, s)).toISOString();

  test("stall / thread records reconstruct; an `end` without stalledMs reads as null, never 0", () => {
    const records: ProgressRecord[] = [
      { ...base, t: at(0), phase: "run", scope: null, requested: null },
      {
        ...base,
        t: at(1),
        phase: "selected",
        treeHash: null,
        selected: ["old", "new"],
      },
      { ...base, t: at(2), phase: "start", checkId: "old" },
      { ...base, t: at(2), phase: "start", checkId: "new" },
      // Written before the watch existed: no stalledMs, no queuedMs.
      {
        ...base,
        t: at(3),
        phase: "end",
        checkId: "old",
        durationMs: 900,
        ok: true,
        cached: false,
      },
      {
        ...base,
        t: at(9),
        phase: "stall",
        offsetMs: 1_200,
        durationMs: 7_450,
        lateMs: 7_400,
        running: ["new"],
        bootstrap: [],
        samples: 300,
        owners: [
          {
            owner: "check x",
            samples: 180,
            detail: [],
            example: ["spin @ a.ts:1"],
          },
        ],
      },
      {
        ...base,
        t: at(9),
        phase: "end",
        checkId: "new",
        durationMs: 7_600,
        ok: true,
        cached: false,
        queuedMs: 0,
        stalledMs: 7_400,
      },
      {
        ...base,
        t: at(10),
        phase: "thread",
        longestLateMs: 7_400,
        stallCount: 1,
        stalledMs: 7_400,
        samples: 420,
        rateHz: 40.3,
        selfMs: 12,
        owners: [{ owner: "check x", samples: 200, detail: [], ms: 4_963 }],
        stallOwners: [{ owner: "check x", samples: 180, detail: [] }],
      },
      { ...base, t: at(10), phase: "done", elapsedMs: 10_000, allOk: true },
    ];

    const [run] = reconstructRuns(records);
    expect(
      run?.completed.map((c) => [c.checkId, c.queuedMs, c.stalledMs]),
    ).toEqual([
      ["old", 0, null],
      ["new", 0, 7_400],
    ]);
    expect(run?.stalls).toEqual([
      {
        at: at(9),
        offsetMs: 1_200,
        durationMs: 7_450,
        lateMs: 7_400,
        running: ["new"],
        bootstrap: [],
        samples: 300,
        owners: [
          {
            owner: "check x",
            samples: 180,
            detail: [],
            example: ["spin @ a.ts:1"],
          },
        ],
        // This stall's record predates the kind/cpu split — null, never 0.
        kinds: null,
        leaves: null,
        cpu: null,
      },
    ]);
    expect(run?.thread).toMatchObject({
      at: at(10),
      stallCount: 1,
      rateHz: 40.3,
    });
    expect(run?.thread?.kinds).toBeNull();
    expect(run?.thread?.cpu).toBeNull();
    expect(run?.done).toEqual({ at: at(10), elapsedMs: 10_000, allOk: true });
  });

  test("a stall/thread record WITH kinds/leaves/cpu reconstructs them, not null", () => {
    const kinds = {
      "blocking-io": 5,
      process: 0,
      "module-load": 0,
      cpu: 1,
      native: 0,
    };
    const cpu = { userMs: 12, systemMs: 3 };
    const leaves = [{ leaf: "readdirSync [native]", samples: 5 }];
    const records: ProgressRecord[] = [
      { ...base, t: at(0), phase: "run", scope: null, requested: null },
      {
        ...base,
        t: at(1),
        phase: "stall",
        offsetMs: 0,
        durationMs: 1_000,
        lateMs: 950,
        running: [],
        bootstrap: [],
        samples: 6,
        owners: [],
        kinds,
        leaves,
        cpu,
      },
      {
        ...base,
        t: at(2),
        phase: "thread",
        longestLateMs: 950,
        stallCount: 1,
        stalledMs: 950,
        samples: 6,
        rateHz: null,
        selfMs: 1,
        owners: [],
        stallOwners: [],
        kinds,
        cpu,
      },
      { ...base, t: at(2), phase: "done", elapsedMs: 2_000, allOk: true },
    ];
    const [run] = reconstructRuns(records);
    expect(run?.stalls[0]?.kinds).toEqual(kinds);
    expect(run?.stalls[0]?.leaves).toEqual(leaves);
    expect(run?.stalls[0]?.cpu).toEqual(cpu);
    expect(run?.thread?.kinds).toEqual(kinds);
    expect(run?.thread?.cpu).toEqual(cpu);
  });

  test("a run recorded before the watch has no thread and no stalls, not an empty summary", () => {
    const [run] = reconstructRuns([
      { ...base, t: at(0), phase: "run", scope: null, requested: null },
      { ...base, t: at(1), phase: "done", elapsedMs: 1_000, allOk: true },
    ]);
    expect(run?.thread).toBeNull();
    expect(run?.stalls).toEqual([]);
  });

  test("a check waiting on another run's flight is outstanding as JOINED, and leaves the running set", () => {
    const { records, write } = recorder();
    const run = startProgressRun(
      { scope: null, requested: null },
      { write, sampler: fakeSampler([]), reports: noReports },
    );
    run.checkStarted("a");
    run.checkStarted("b");
    run.checkJoined("a", "op-leader");
    run.checkJoined("b", null);
    run.checkJoinEnded("b", false); // b's leader published nothing: b runs itself

    const [open] = reconstructRuns(records);
    const byId = new Map(open?.outstanding.map((o) => [o.checkId, o]));
    expect(byId.get("a")?.joined?.leaderId).toBe("op-leader");
    expect(byId.get("b")?.joined).toBeNull();

    run.checkJoinEnded("a", true);
    run.checkEnded("a", 5, false, false, 0, "op-leader");
    run.checkEnded("b", 5, true, false, 0, null);
    run.finish(false);
    const [done] = reconstructRuns(records);
    expect(done?.outstanding).toEqual([]);
    expect(done?.completed.map((c) => [c.checkId, c.sharedFrom])).toEqual([
      ["a", "op-leader"],
      ["b", null],
    ]);
    // `sharedFrom` is written only when set.
    const endB = records.find((r) => r.phase === "end" && r.checkId === "b");
    expect(endB && "sharedFrom" in endB).toBe(false);
  });
});
