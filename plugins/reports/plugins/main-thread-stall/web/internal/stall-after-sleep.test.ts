// A real stall in a tab after the device slept keeps its evidence: the LoAF
// frame is the stall's `stallFrame` and the profiler's samples are its
// stacks. The performance timeline pauses while the device sleeps (Chrome on
// Android, macOS) and the wall clock does not, so after a sleep
// `timeOrigin + stamp` lags `Date.now()` by the sleep — report-1795091821-xwqzky
// (Android, ~2.2 h asleep): `sampled` with `sampledMs: 0`, every sample hours
// before the stall. The device here is simulated: both clocks are stubbed and
// a sleep advances only the wall clock.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  asEpochMs,
  epochNow,
  perfNow,
  readClocks,
  type ClockReading,
} from "@plugins/primitives/plugins/perfs/plugins/page-clock/core";
import type { StallFrame, StallTab } from "../../core";
import { STALL } from "./constants";
import { toStallFrame, type LoafEntry } from "./loaf";
import { reduceStallStacks, type ProfilerTrace } from "./stack-profile";
import { createStallMachine, step, type StallEffect } from "./stall-machine";

/** The page loaded at this wall-clock instant (its `performance.timeOrigin`). */
const LOADED_AT = 1_763_500_000_000;
const SLEPT_MS = 2.2 * 60 * 60 * 1000;
const IV = 20;

/** A device: the wall clock always runs, the performance timeline only awake. */
const device = { wall: LOADED_AT, perf: 0 };
const awake = (ms: number): void => {
  device.wall += ms;
  device.perf += ms;
};
const asleep = (ms: number): void => {
  device.wall += ms;
};

const spies: { mockRestore(): void }[] = [];
beforeEach(() => {
  device.wall = LOADED_AT;
  device.perf = 0;
  spies.push(
    spyOn(Date, "now").mockImplementation(() => device.wall),
    spyOn(performance, "now").mockImplementation(() => device.perf),
  );
});
afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore();
});

const TAB: StallTab = {
  tabId: "A",
  app: "agent-manager",
  routePattern: "conversation",
  url: "http://x.localhost:9000/agents/c/A",
  visible: true,
  focused: true,
};

/** A long animation frame entry as Chrome delivers it: on the performance timeline. */
function loafEntry(startTime: number, duration: number): LoafEntry {
  return {
    name: "long-animation-frame",
    entryType: "long-animation-frame",
    startTime,
    duration,
    blockingDuration: duration - 50,
    renderStart: 0,
    styleAndLayoutStart: 0,
    scripts: [
      {
        startTime,
        invokerType: "user-callback",
        invoker: "Window.setTimeout",
        sourceURL: "http://x/app.js",
        sourceFunctionName: "spin",
        sourceCharPosition: 10,
        duration,
        forcedStyleAndLayoutDuration: 0,
        pauseDuration: 0,
      },
    ],
    toJSON: () => ({}),
  };
}

const SPIN_TRACE: Omit<ProfilerTrace, "samples"> = {
  resources: ["http://x/app.js"],
  frames: [{ name: "spin", resourceId: 0, line: 10, column: 5 }],
  stacks: [{ frameId: 0 }],
};

describe("a stall after the device slept", () => {
  test("its LoAF frame is the stall's frame and its samples are its stacks", () => {
    // The tab ran a minute, then the device slept 2.2 h.
    awake(60_000);
    asleep(SLEPT_MS);

    // Woken: the tab is visible again, attaches to the watchdog (wall-clock
    // pongs, as the worker reads `Date.now()`) and starts a profiler.
    const m = createStallMachine({ workerId: "w", newId: () => "inc-1" });
    const fx: StallEffect[] = [];
    fx.push(...step(m, { type: "clock-started", now: Date.now() }));
    fx.push(
      ...step(m, {
        type: "attach",
        portId: "a",
        tab: TAB,
        frozen: false,
        now: Date.now(),
      }),
    );
    // As stall-profiler.ts does: both clocks read at the start, on each
    // pulse (ping) and at the stop.
    const profilerStartedAt = epochNow();
    const clocks: ClockReading[] = [readClocks()];
    const samples: ProfilerTrace["samples"] = [];
    const sampleFor = (ms: number): void => {
      for (let t = 0; t < ms; t += IV) {
        samples.push({ timestamp: perfNow(), stackId: 0 });
        awake(IV);
      }
    };
    // Two healthy seconds, answered.
    for (let i = 0; i < 2; i++) {
      awake(STALL.PING_MS);
      fx.push(...step(m, { type: "tick", now: Date.now() }));
      fx.push(...step(m, { type: "pong", portId: "a", now: Date.now() }));
      clocks.push(readClocks());
    }

    // The thread freezes 7 s in `spin`: V8 keeps sampling; the watchdog's
    // ticks go unanswered.
    const frozeAtPerf = perfNow();
    const frozeAtWall = epochNow();
    for (let i = 0; i < 7; i++) {
      sampleFor(STALL.PING_MS);
      fx.push(...step(m, { type: "tick", now: Date.now() }));
    }
    expect(m.incidents.size).toBe(1);

    // Back: the pong, then the LoAF entry, converted as the tab does on delivery.
    fx.push(...step(m, { type: "pong", portId: "a", now: Date.now() }));
    const frame: StallFrame = toStallFrame(loafEntry(frozeAtPerf, 7000));
    expect(frame.startedAt).toBe(frozeAtWall);
    fx.push(...step(m, { type: "frame", portId: "a", frame, now: Date.now() }));
    // The profiler is stopped as the tab files (stacksFor rotates it).
    clocks.push(readClocks());
    const stoppedAt = epochNow();
    for (let i = 0; i < 3; i++) {
      awake(STALL.PING_MS);
      fx.push(...step(m, { type: "tick", now: Date.now() }));
      fx.push(...step(m, { type: "pong", portId: "a", now: Date.now() }));
    }

    const delivered = fx.find(
      (e): e is Extract<StallEffect, { type: "deliver" }> =>
        e.type === "deliver",
    );
    if (!delivered) throw new Error("the stall was not filed");
    const draft = delivered.payload;
    expect(draft.ended).toBe("recovered");
    // Attributed: the frame overlapping the stall is its stallFrame.
    expect(draft.stallFrame?.startedAt).toBe(frozeAtWall);
    expect(draft.topFunction).toBe("spin (Window.setTimeout)");

    // Its stacks: the samples inside the watchdog's window, all of them spin.
    const stacks = reduceStallStacks({
      traces: [
        {
          trace: { ...SPIN_TRACE, samples },
          clocks,
          startedAt: profilerStartedAt,
          stoppedAt,
          full: false,
        },
      ],
      startedAt: asEpochMs(draft.startedAt),
      endedAt: asEpochMs(draft.endedAt),
      sampleIntervalMs: IV,
    });
    if (stacks.kind !== "sampled") throw new Error(stacks.reason);
    expect(stacks.sampledMs).toBe(7000);
    expect(stacks.stacks[0]?.frames).toEqual(["spin (http://x/app.js:10:5)"]);

    // What `timeOrigin + timestamp` made of the same samples: 2.2 h before
    // the stall, so none of them was its stacks.
    const first = samples[0]!.timestamp;
    expect(LOADED_AT + first).toBe(frozeAtWall - SLEPT_MS);
    expect(LOADED_AT + first).toBeLessThan(draft.startedAt);
  });

  test("a profile the device slept through places each side of the sleep where it ran", () => {
    // macOS: a visible page through a lid close keeps its profiler running.
    const startedAt = epochNow();
    const clocks: ClockReading[] = [readClocks()];
    const samples: ProfilerTrace["samples"] = [];
    const busy = (ms: number, stackId?: number): void => {
      for (let t = 0; t < ms; t += IV) {
        samples.push(
          stackId === undefined
            ? { timestamp: perfNow() }
            : { timestamp: perfNow(), stackId },
        );
        awake(IV);
      }
      clocks.push(readClocks()); // the pulse after each second
    };
    // 3 s of spin before the sleep, then idle after the wake.
    for (let i = 0; i < 3; i++) busy(1000, 0);
    const spunUntil = epochNow();
    asleep(SLEPT_MS);
    const wokeAt = epochNow();
    for (let i = 0; i < 3; i++) busy(1000);
    const stoppedAt = epochNow();
    const trace = {
      trace: { ...SPIN_TRACE, samples },
      clocks,
      startedAt,
      stoppedAt,
      full: false,
    };

    // The 3 s before the sleep hold the spin, where it ran.
    const before = reduceStallStacks({
      traces: [trace],
      startedAt,
      endedAt: spunUntil,
      sampleIntervalMs: IV,
    });
    if (before.kind !== "sampled") throw new Error(before.reason);
    expect(before.sampledMs).toBe(3000);
    expect(before.noJsMs).toBe(0);

    // The 3 s after the wake hold no JS: no spin carried across the sleep.
    const after = reduceStallStacks({
      traces: [trace],
      startedAt: wokeAt,
      endedAt: stoppedAt,
      sampleIntervalMs: IV,
    });
    if (after.kind !== "sampled") throw new Error(after.reason);
    // (Less the one sample taken at the very instant of the sleep's last
    // reading: the timeline did not move across the sleep, so it is placed
    // before it.)
    expect(after.sampledMs).toBe(3000 - IV);
    expect(after.noJsMs).toBe(after.sampledMs);
  });
});
