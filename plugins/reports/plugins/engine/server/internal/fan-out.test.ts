/**
 * Suite for the reports engine's cross-fingerprint fan-out ceiling
 * (research/2026-09-02-global-alert-fan-out-ceiling.md). The core is
 * deterministic over an explicit clock and budget, so the semantics that matter
 * — the budget is spent by a fingerprint NEWLY alerting (repeats pass through),
 * the window re-grants it, and nothing collapsed is ever silently lost — are
 * asserted directly, with no DB and no timers.
 *
 * Run: `./singularity test plugins/reports`
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  _setFanOutConfigForTests,
  _setStormTimerForTests,
  createFanOutCore,
  createFanOutGate,
  type FanOutBudget,
  type FanOutConfigValues,
  type StormSummary,
} from "./fan-out";

const budget = (over: Partial<FanOutBudget> = {}): FanOutBudget => ({
  distinctPerWindow: 3,
  windowMs: 60_000,
  rosterMax: 50,
  ...over,
});

const T0 = 1_000_000;

describe("createFanOutCore", () => {
  test("the first N distinct fingerprints alert; the rest collapse", () => {
    const core = createFanOutCore();
    const b = budget({ distinctPerWindow: 3 });
    for (const fp of ["a", "b", "c"]) {
      expect(core.admit("slow-op", fp, `msg ${fp}`, T0, b).alert).toBe(true);
    }
    expect(core.admit("slow-op", "d", "msg d", T0, b).alert).toBe(false);
    expect(core.admit("slow-op", "e", "msg e", T0, b).alert).toBe(false);

    const storm = core.takeStorm("slow-op", T0 + 60_000);
    expect(storm).not.toBeNull();
    expect(storm).toMatchObject({
      collapsedKind: "slow-op",
      windowStartedAt: T0,
      windowEndedAt: T0 + 60_000,
      budget: 3,
      distinctFingerprints: 2,
      occurrences: 2,
      rosterTruncated: 0,
    });
    expect(storm?.roster.map((e) => e.fingerprint).sort()).toEqual(["d", "e"]);
  });

  test("a repeat of an already-alerting fingerprint is not fan-out", () => {
    const core = createFanOutCore();
    const b = budget({ distinctPerWindow: 2 });
    expect(core.admit("crash", "a", "m", T0, b).alert).toBe(true);
    expect(core.admit("crash", "b", "m", T0, b).alert).toBe(true);
    // Budget exhausted — but "a" already holds an alert this window, so its
    // repeats keep landing on their row (count bump + bell cooldown), and they
    // do not re-spend the budget.
    for (let i = 0; i < 10; i++) {
      expect(core.admit("crash", "a", "m", T0 + i, b).alert).toBe(true);
    }
    expect(core.admit("crash", "c", "m", T0, b).alert).toBe(false);
    expect(core.takeStorm("crash", T0)?.occurrences).toBe(1);
  });

  test("the window roll re-grants the budget — collapse is temporary", () => {
    const core = createFanOutCore();
    const b = budget({ distinctPerWindow: 1, windowMs: 60_000 });
    expect(core.admit("slow-op", "a", "m", T0, b).alert).toBe(true);
    expect(core.admit("slow-op", "b", "m", T0, b).alert).toBe(false);
    // Still inside the window at the boundary itself.
    expect(core.admit("slow-op", "c", "m", T0 + 60_000, b).alert).toBe(false);
    // Past it: a persistent problem mints its own row in the next window.
    expect(core.admit("slow-op", "b", "m", T0 + 60_001, b).alert).toBe(true);
    // …and the fingerprint that alerted in the PREVIOUS window has to re-win
    // its place, so the ceiling is per window, not per process.
    expect(core.admit("slow-op", "a", "m", T0 + 60_002, b).alert).toBe(false);
  });

  test("a window roll never discards an untaken storm", () => {
    const core = createFanOutCore();
    const b = budget({ distinctPerWindow: 1, windowMs: 60_000 });
    core.admit("slow-op", "a", "m", T0, b);
    core.admit("slow-op", "b", "m", T0, b); // collapsed in window 1
    core.admit("slow-op", "c", "m", T0 + 60_001, b); // rolls; "c" alerts
    core.admit("slow-op", "d", "m", T0 + 60_002, b); // collapsed in window 2
    const storm = core.takeStorm("slow-op", T0 + 60_003);
    // The accumulator is owed until taken, so both windows' collapses are in it
    // and it still carries the instant the collapsing STARTED.
    expect(storm?.occurrences).toBe(2);
    expect(storm?.windowStartedAt).toBe(T0);
    expect(storm?.roster.map((e) => e.fingerprint).sort()).toEqual(["b", "d"]);
  });

  test("the roster is capped; the tail keeps its accounting", () => {
    const core = createFanOutCore();
    const b = budget({ distinctPerWindow: 1, rosterMax: 2 });
    core.admit("slow-op", "seed", "m", T0, b);
    for (const fp of ["a", "b", "c", "d"]) {
      core.admit("slow-op", fp, `msg ${fp}`, T0, b);
    }
    // A repeat of a fingerprint the roster could not name still counts.
    core.admit("slow-op", "d", "msg d", T0, b);

    const storm = core.takeStorm("slow-op", T0 + 1_000);
    expect(storm?.roster).toHaveLength(2);
    expect(storm?.roster.map((e) => e.fingerprint)).toEqual(["a", "b"]);
    expect(storm?.distinctFingerprints).toBe(4);
    expect(storm?.rosterTruncated).toBe(2);
    expect(storm?.occurrences).toBe(5);
  });

  test("the roster counts repeats and names the loudest first", () => {
    const core = createFanOutCore();
    const b = budget({ distinctPerWindow: 0 });
    core.admit("slow-op", "quiet", "quiet msg", T0, b);
    for (let i = 0; i < 4; i++) {
      core.admit("slow-op", "loud", "loud msg", T0, b);
    }
    const storm = core.takeStorm("slow-op", T0);
    expect(storm?.roster).toEqual([
      { fingerprint: "loud", message: "loud msg", count: 4 },
      { fingerprint: "quiet", message: "quiet msg", count: 1 },
    ]);
  });

  test("takeStorm closes the storm; nothing collapsed owes nothing", () => {
    const core = createFanOutCore();
    const b = budget({ distinctPerWindow: 1 });
    core.admit("slow-op", "a", "m", T0, b);
    expect(core.stormOwed("slow-op")).toBe(false);
    expect(core.takeStorm("slow-op", T0)).toBeNull();

    core.admit("slow-op", "b", "m", T0, b);
    expect(core.stormOwed("slow-op")).toBe(true);
    expect(core.takeStorm("slow-op", T0)).not.toBeNull();
    expect(core.stormOwed("slow-op")).toBe(false);
    expect(core.takeStorm("slow-op", T0)).toBeNull();
  });

  test("each kind gets its own budget", () => {
    const core = createFanOutCore();
    const b = budget({ distinctPerWindow: 1 });
    expect(core.admit("slow-op", "a", "m", T0, b).alert).toBe(true);
    expect(core.admit("slow-op", "b", "m", T0, b).alert).toBe(false);
    // A storm in one kind must never spend another kind's budget — an
    // unrelated crash filed during the burst still gets its row.
    expect(core.admit("crash", "a", "m", T0, b).alert).toBe(true);
    expect(core.takeStorm("crash", T0)).toBeNull();
  });
});

// --- The wrapper: live config + the one-shot storm timer ---------------------

const cfg = (over: Partial<FanOutConfigValues> = {}): FanOutConfigValues => ({
  fanOutPerWindow: 2,
  fanOutWindowMs: 60_000,
  stormRosterMax: 50,
  ...over,
});

let armedStorms: (() => void)[] = [];
let armedDelays: number[] = [];

beforeEach(() => {
  _setFanOutConfigForTests(cfg());
  armedStorms = [];
  armedDelays = [];
  _setStormTimerForTests({
    set: (fn, delayMs) => {
      armedStorms.push(fn);
      armedDelays.push(delayMs);
    },
  });
});

afterEach(() => {
  _setFanOutConfigForTests(null);
  _setStormTimerForTests(null);
});

function makeGate() {
  const storms: StormSummary[] = [];
  const gate = createFanOutGate({ onStorm: (s) => storms.push(s) });
  return { gate, storms };
}

describe("createFanOutGate", () => {
  test("the first collapse arms exactly one window-long one-shot", () => {
    const { gate, storms } = makeGate();
    const admit = (fp: string) =>
      gate.admit({ kind: "slow-op", fingerprint: fp, message: `m ${fp}` });
    expect(admit("a").alert).toBe(true);
    expect(admit("b").alert).toBe(true);
    expect(admit("c").alert).toBe(false);
    expect(admit("d").alert).toBe(false);
    // One timer for the whole storm, never a poll.
    expect(armedStorms).toHaveLength(1);
    expect(armedDelays).toEqual([60_000]);
    expect(storms).toHaveLength(0);

    armedStorms[0]!();
    expect(storms).toHaveLength(1);
    expect(storms[0]).toMatchObject({
      collapsedKind: "slow-op",
      budget: 2,
      distinctFingerprints: 2,
      occurrences: 2,
    });

    // The next storm re-arms: one rollup per storm, not one per process.
    expect(admit("e").alert).toBe(false);
    expect(armedStorms).toHaveLength(2);
  });

  test("a fired timer with nothing owed files nothing", () => {
    const { gate, storms } = makeGate();
    gate.admit({ kind: "slow-op", fingerprint: "a", message: "m" });
    gate.admit({ kind: "slow-op", fingerprint: "b", message: "m" });
    gate.admit({ kind: "slow-op", fingerprint: "c", message: "m" });
    expect(armedStorms).toHaveLength(1);
    armedStorms[0]!();
    armedStorms[0]!();
    expect(storms).toHaveLength(1);
  });

  test("a kind may raise its ceiling, never lower it", () => {
    const { gate } = makeGate();
    const admit = (fp: string, fanOutPerWindow?: number) =>
      gate.admit({ kind: "k", fingerprint: fp, message: "m", fanOutPerWindow });
    // Raised to 4 against the config's 2.
    expect(admit("a", 4).alert).toBe(true);
    expect(admit("b", 4).alert).toBe(true);
    expect(admit("c", 4).alert).toBe(true);
    expect(admit("d", 4).alert).toBe(true);
    expect(admit("e", 4).alert).toBe(false);

    // A raise BELOW the engine default is not a lowering: the config floor wins.
    const { gate: g2 } = makeGate();
    const admit2 = (fp: string) =>
      g2.admit({
        kind: "k",
        fingerprint: fp,
        message: "m",
        fanOutPerWindow: 1,
      });
    expect(admit2("a").alert).toBe(true);
    expect(admit2("b").alert).toBe(true);
    expect(admit2("c").alert).toBe(false);
  });

  test("there is no spelling for 'no ceiling'", () => {
    const { gate } = makeGate();
    for (const bad of [0, -1, Infinity, 1.5, Number.NaN]) {
      expect(() =>
        gate.admit({
          kind: "k",
          fingerprint: "a",
          message: "m",
          fanOutPerWindow: bad,
        }),
      ).toThrow(/positive integer/);
    }
  });
});
