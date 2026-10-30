import { describe, expect, test } from "bun:test";
import type {
  StackFrame,
  StackSample,
} from "@plugins/infra/plugins/stack-sampler/core";
import {
  STALL_MS,
  TICK_MS,
  createWatchState,
  noteStarted,
  overlapMs,
  stepWatch,
  summarizeWatch,
  type InFlight,
  type WatchClocks,
} from "./thread-watch";

// The tick step is pure over (state, now, samples): no timer, no sampler, no
// clock. Every instant below is a synthetic `performance.now()` reading.
const ROOTS = ["/repo"];

function js(name: string, sourceURL: string): StackFrame {
  return { name, sourceURL, line: 1, column: 1, category: "JIT" };
}

function native(name: string): StackFrame {
  return {
    name,
    sourceURL: null,
    line: null,
    column: null,
    category: "native",
  };
}

function samples(n: number, frames: StackFrame[]): StackSample[] {
  return Array.from({ length: n }, (_, i) => ({
    timestamp: i,
    frames,
    activity: null,
  }));
}

const IN_CHECK_X = [js("spin", "/repo/plugins/x/check/index.ts")];
const IN_HELPER = [js("helper", "/repo/plugins/y/core/helper.ts")];
const BLOCKING = [native("readdirSync")];

const idle = (): InFlight => ({ running: [], bootstrap: [] });
const running =
  (...ids: string[]) =>
  (): InFlight => ({ running: ids, bootstrap: [] });

/** A synthetic absolute `process.cpuUsage()` reading, in ms (converted to the
 *  µs the real API uses). Cumulative-since-zero, same as the real thing, so a
 *  delta between two of these is just their difference. */
const cpu = (userMs: number, systemMs: number, threadMs = 0): WatchClocks => ({
  process: {
    user: Math.round(userMs * 1000),
    system: Math.round(systemMs * 1000),
  },
  thread: { supported: true, ms: threadMs },
});
/** The constant reading every test that isn't ABOUT cpu accounting passes at
 *  every tick — every delta is then 0, disturbing nothing else. */
const NO_CPU = cpu(0, 0);

describe("stepWatch", () => {
  test("a native-only sample carrying an activity is owned by that activity", () => {
    const state = createWatchState(0, ROOTS, idle(), NO_CPU);
    const during: StackSample = {
      timestamp: 0,
      frames: [native("(anonymous)")],
      activity: {
        name: "barrel import",
        detail: "plugins/apps/plugins/mail/web/index.ts",
      },
    };
    const stall = stepWatch(
      state,
      2_050,
      [during, during, ...samples(1, BLOCKING)],
      idle,
      NO_CPU,
    );
    expect(stall?.owners.map((o) => [o.owner, o.samples, o.detail])).toEqual([
      [
        "native during barrel import",
        2,
        [{ name: "plugins/apps/plugins/mail/web/index.ts", samples: 2 }],
      ],
      ["native readdirSync [native]", 1, []],
    ]);
  });

  test("a late tick under STALL_MS records nothing, but is the longest late", () => {
    const state = createWatchState(0, ROOTS, idle(), NO_CPU);
    expect(stepWatch(state, TICK_MS, [], idle, NO_CPU)).toBeNull();
    expect(
      stepWatch(state, TICK_MS + 950, samples(5, IN_CHECK_X), idle, NO_CPU),
    ).toBeNull();
    expect(state.stalls).toEqual([]);
    expect(state.longestLateMs).toBe(900);
    // Every drained sample is still attributed to the whole run.
    expect(state.run.samples).toBe(5);
  });

  test("a 7 s gap records one stall, owned by THAT batch, with the set in flight when it began", () => {
    const state = createWatchState(0, ROOTS, idle(), NO_CPU);
    stepWatch(state, 50, samples(2, IN_HELPER), running("a", "b"), NO_CPU);
    const stall = stepWatch(
      state,
      7_050,
      [...samples(3, IN_CHECK_X), ...samples(1, IN_HELPER)],
      running("c"),
      NO_CPU,
    );
    expect(stall).toMatchObject({
      offsetMs: 50,
      durationMs: 7_000,
      lateMs: 7_000 - TICK_MS,
      running: ["a", "b"],
      bootstrap: [],
      samples: 4,
    });
    expect(stall?.owners.map((o) => [o.owner, o.samples])).toEqual([
      ["check x", 3],
      ["shared helper @ plugins/y/core/helper.ts", 1],
    ]);
  });

  test("back-to-back stalls: the second's `running` is the set at the tick between them", () => {
    const state = createWatchState(0, ROOTS, running("a")(), NO_CPU);
    stepWatch(state, 2_000, [], running("b"), NO_CPU);
    const second = stepWatch(state, 4_000, [], running("c"), NO_CPU);
    expect(state.stalls[0]?.running).toEqual(["a"]);
    expect(second?.running).toEqual(["b"]);
  });

  test("a check that starts and blocks in the same turn is in the stall's `running`, though no tick saw it", () => {
    // The start wave of a full pass: no tick between the burst of starts and
    // the block, so the last tick's snapshot is empty.
    const state = createWatchState(0, ROOTS, idle(), NO_CPU);
    noteStarted(state, "running", "x");
    noteStarted(state, "bootstrap", "load-checks");
    const stall = stepWatch(state, 5_000, samples(3, IN_CHECK_X), idle, NO_CPU);
    expect(stall?.running).toEqual(["x"]);
    expect(stall?.bootstrap).toEqual(["load-checks"]);
    // The window closes with the stall: the next one starts from the tick's set.
    const next = stepWatch(state, 10_000, [], idle, NO_CPU);
    expect(next?.running).toEqual([]);
  });

  test("a stall tallies its samples' kinds and keeps the busiest raw leaves", () => {
    const state = createWatchState(0, ROOTS, idle(), NO_CPU);
    const stall = stepWatch(
      state,
      1_050,
      [...samples(3, BLOCKING), ...samples(2, IN_CHECK_X)],
      idle,
      NO_CPU,
    );
    expect(stall?.kinds).toEqual({
      "blocking-io": 3,
      process: 0,
      "module-load": 0,
      cpu: 2,
      native: 0,
    });
    expect(stall?.leaves).toEqual([
      { leaf: "readdirSync [native]", samples: 3 },
      { leaf: "spin @ plugins/x/check/index.ts:1", samples: 2 },
    ]);
  });

  test("a stall's cpu is the process cpuUsage delta over its own window", () => {
    const state = createWatchState(0, ROOTS, idle(), cpu(0, 0));
    stepWatch(state, 50, [], idle, cpu(0, 0));
    const stall = stepWatch(state, 1_100, [], idle, cpu(300, 50));
    expect(stall?.cpu).toEqual({ userMs: 300, systemMs: 50 });
  });
});

describe("held vs starved", () => {
  test("a stall the thread spent on its own CPU is held", () => {
    const state = createWatchState(0, ROOTS, idle(), cpu(0, 0, 0));
    const stall = stepWatch(
      state,
      3_050,
      samples(10, IN_CHECK_X),
      idle,
      cpu(2_600, 0, 2_500),
    );
    expect(stall?.held).toEqual({
      measured: true,
      threadCpuMs: 2_500,
      blockedMs: 0,
      heldMs: 2_500,
      starvedMs: 500,
    });
  });

  test("a stall the OS did not schedule the thread for is starved, whatever the samples say", () => {
    const state = createWatchState(0, ROOTS, idle(), cpu(0, 0, 0));
    const stall = stepWatch(
      state,
      9_050,
      samples(5, IN_CHECK_X),
      idle,
      cpu(1_800, 0, 300),
    );
    expect(stall?.held).toEqual({
      measured: true,
      threadCpuMs: 300,
      blockedMs: 0,
      heldMs: 300,
      starvedMs: 8_700,
    });
  });

  test("a synchronous syscall holds the thread without CPU: its sample share counts as held", () => {
    const state = createWatchState(0, ROOTS, idle(), cpu(0, 0, 0));
    const stall = stepWatch(
      state,
      4_050,
      [...samples(8, BLOCKING), ...samples(2, IN_CHECK_X)],
      idle,
      cpu(100, 0, 100),
    );
    expect(stall?.held).toEqual({
      measured: true,
      threadCpuMs: 100,
      blockedMs: 3_200,
      heldMs: 3_300,
      starvedMs: 700,
    });
  });

  test("held never exceeds lateMs", () => {
    const state = createWatchState(0, ROOTS, idle(), cpu(0, 0, 0));
    const stall = stepWatch(state, 2_050, [], idle, cpu(0, 0, 2_100));
    expect(stall?.held).toMatchObject({ heldMs: 2_000, starvedMs: 0 });
  });

  test("without a thread clock the split is unmeasured, never zero", () => {
    const none: WatchClocks = {
      process: { user: 0, system: 0 },
      thread: { supported: false },
    };
    const state = createWatchState(0, ROOTS, idle(), none);
    const stall = stepWatch(state, 3_050, [], idle, none);
    expect(stall?.held).toEqual({ measured: false });
    const summary = summarizeWatch(state);
    expect(summary.held).toBeNull();
    expect(summary.selfClock).toBe("wall");
  });

  test("the summary sums held and starved over the stalls", () => {
    const state = createWatchState(0, ROOTS, idle(), cpu(0, 0, 0));
    stepWatch(state, 3_050, [], idle, cpu(0, 0, 2_500)); // 3000 late, 2500 held
    stepWatch(state, 5_100, [], idle, cpu(0, 0, 2_700)); // 2000 late, 200 held
    const summary = summarizeWatch(state);
    expect(summary.held).toEqual({
      heldMs: 2_700,
      starvedMs: 2_300,
      longestHeldMs: 2_500,
    });
  });
});

describe("summarizeWatch", () => {
  test("the rate is measured from stall windows only, and turns sample counts into ms", () => {
    const state = createWatchState(0, ROOTS, idle(), NO_CPU);
    // 30 samples outside any stall: counted, but no evidence of the rate.
    stepWatch(state, 50, samples(30, IN_HELPER), idle, NO_CPU);
    // 70 samples over a 7 000 ms stall window → 10 Hz.
    stepWatch(state, 7_050, samples(70, IN_CHECK_X), idle, NO_CPU);
    const summary = summarizeWatch(state);
    expect(summary.rateHz).toBe(10);
    expect(summary.stallCount).toBe(1);
    expect(summary.stalledMs).toBe(6_950);
    expect(summary.samples).toBe(100);
    expect(summary.owners.map((o) => [o.owner, o.samples, o.ms])).toEqual([
      ["check x", 70, 7_000],
      ["shared helper @ plugins/y/core/helper.ts", 30, 3_000],
    ]);
    // "mostly X" ranks stall time, where the helper never ran.
    expect(summary.stallOwners.map((o) => o.owner)).toEqual(["check x"]);
  });

  test("no stall → shares only: rate and ms are null, never a guessed number", () => {
    const state = createWatchState(0, ROOTS, idle(), NO_CPU);
    stepWatch(state, 50, samples(10, IN_HELPER), idle, NO_CPU);
    const summary = summarizeWatch(state);
    expect(summary.stallCount).toBe(0);
    expect(summary.rateHz).toBeNull();
    expect(summary.owners[0]?.ms).toBeNull();
    expect(summary.longestLateMs).toBe(0);
  });

  test("kinds is a whole-run tally too, not narrowed to stall windows", () => {
    const state = createWatchState(0, ROOTS, idle(), NO_CPU);
    // Under STALL_MS late: no stall, but still attributed.
    stepWatch(state, 50, samples(4, BLOCKING), idle, NO_CPU);
    const summary = summarizeWatch(state);
    expect(summary.stallCount).toBe(0);
    expect(summary.kinds["blocking-io"]).toBe(4);
    expect(summary.samples).toBe(4);
  });

  test("the whole-run cpu total accumulates every tick's delta, stall or not", () => {
    const state = createWatchState(0, ROOTS, idle(), cpu(0, 0));
    stepWatch(state, 50, [], idle, cpu(10, 2)); // no stall
    stepWatch(state, 1_100, [], idle, cpu(30, 5)); // stall
    const summary = summarizeWatch(state);
    expect(summary.cpu).toEqual({ userMs: 30, systemMs: 5 });
  });
});

describe("overlapMs", () => {
  test("counts the known-busy part of recorded stalls inside the window", () => {
    const state = createWatchState(0, ROOTS, idle(), NO_CPU);
    stepWatch(state, 50, [], idle, NO_CPU);
    stepWatch(state, 7_050, [], idle, NO_CPU); // busy window [100, 7050]
    expect(overlapMs(state, 0, 3_000, 7_060)).toBe(2_900);
    expect(overlapMs(state, 7_050, 8_000, 8_000)).toBe(0);
  });

  test("counts the CURRENT gap once it is already over STALL_MS, before the late tick runs", () => {
    const state = createWatchState(0, ROOTS, idle(), NO_CPU);
    stepWatch(state, 50, [], idle, NO_CPU);
    const due = 50 + TICK_MS;
    // Gap still under the threshold: nothing is a stall yet.
    expect(overlapMs(state, 0, due + 500, due + 500)).toBe(0);
    // Gap over it: the open part counts, clipped to the asked window.
    const now = due + STALL_MS + 900;
    expect(overlapMs(state, now - 1_000, now, now)).toBe(1_000);
    expect(overlapMs(state, 0, now, now)).toBe(STALL_MS + 900);
  });
});
