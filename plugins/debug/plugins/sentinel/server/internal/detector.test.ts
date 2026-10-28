import { describe, expect, test } from "bun:test";
import type { ClusterSample } from "../../core";
import {
  createOnsetDetector,
  signalsAt,
  type DetectorThresholds,
} from "./detector";

const T: DetectorThresholds = {
  onLocksWaiting: 5,
  onBlkReadDeltaMs: 2000,
  onBackendP99Ms: 1000,
  onSlowBackends: 2,
  onDecompressionsPerSec: 50_000,
  onTicks: 3,
  offRatio: 0.6,
  offTicks: 2,
};
const CADENCE = 5000;

function sample(overrides: Partial<ClusterSample> = {}): ClusterSample {
  return {
    wall: 0,
    loadAvg1: 4,
    loadAvg5: 4,
    cpuCount: 18,
    pgActiveBackends: 3,
    pgTotalBackends: 30,
    pgWaitEvents: {},
    pgLocksWaiting: 0,
    pgBlkReadDeltaMs: 0,
    pgXactCommitDelta: 0,
    runningBackends: 3,
    totalActiveConns: 5,
    inFlightBuilds: 0,
    backendP99: {},
    decompressionsPerSec: 0,
    compressorMb: 4_000,
    freeMemMb: 8_000,
    ...overrides,
  };
}

const calm = sample();
const hot = sample({ pgLocksWaiting: 6 }); // ≥ 5 ungranted locks

describe("onset detector hysteresis", () => {
  test("trips only after onTicks consecutive elevated ticks", () => {
    const d = createOnsetDetector();
    expect(d.feed(hot, T, CADENCE)).toBeNull();
    expect(d.feed(hot, T, CADENCE)).toBeNull();
    const event = d.feed(hot, T, CADENCE);
    expect(event).toMatchObject({ kind: "trip", elevated: ["locksWaiting"] });
    if (event?.kind !== "trip") throw new Error("expected trip");
    expect(event.runUpMs).toBe(3 * CADENCE);
    expect(d.tripped).toBe(true);
  });

  test("a calm tick resets the elevation dwell", () => {
    const d = createOnsetDetector();
    d.feed(hot, T, CADENCE);
    d.feed(hot, T, CADENCE);
    d.feed(calm, T, CADENCE); // resets
    d.feed(hot, T, CADENCE);
    d.feed(hot, T, CADENCE);
    expect(d.tripped).toBe(false);
  });

  test("clears only after offTicks consecutive fully-calm ticks; one trip per episode", () => {
    const d = createOnsetDetector();
    d.feed(hot, T, CADENCE);
    d.feed(hot, T, CADENCE);
    d.feed(hot, T, CADENCE); // trip
    // Still elevated: no second trip event.
    expect(d.feed(hot, T, CADENCE)).toBeNull();
    // Locks at 4: under the trip limit, but ≥ 3 (off = 5×0.6) → NOT calm.
    expect(d.feed(sample({ pgLocksWaiting: 4 }), T, CADENCE)).toBeNull();
    expect(d.feed(calm, T, CADENCE)).toBeNull(); // calm 1/2
    // A hot tick mid-cooldown resets the calm dwell.
    expect(d.feed(sample({ pgLocksWaiting: 4 }), T, CADENCE)).toBeNull();
    expect(d.feed(calm, T, CADENCE)).toBeNull(); // calm 1/2
    expect(d.feed(calm, T, CADENCE)).toMatchObject({ kind: "clear" }); // calm 2/2
    expect(d.tripped).toBe(false);
  });

  test("null blkRead delta (first tick / counter reset) is neither elevated nor blocking calm", () => {
    const d = createOnsetDetector();
    const nullDelta = sample({ pgBlkReadDeltaMs: null });
    expect(d.feed(nullDelta, T, CADENCE)).toBeNull();
    expect(d.tripped).toBe(false);
    // And during cooldown a null delta counts as calm on that axis.
    d.feed(hot, T, CADENCE);
    d.feed(hot, T, CADENCE);
    d.feed(hot, T, CADENCE); // trip
    expect(d.feed(nullDelta, T, CADENCE)).toBeNull(); // calm 1/2
    expect(d.feed(nullDelta, T, CADENCE)).toMatchObject({ kind: "clear" });
  });

  test("slow-backend rollup signal", () => {
    const d = createOnsetDetector();
    const slowBackends = sample({ backendP99: { a: 1500, b: 2000, c: 100 } });
    d.feed(slowBackends, T, CADENCE);
    d.feed(slowBackends, T, CADENCE);
    expect(d.feed(slowBackends, T, CADENCE)).toMatchObject({
      kind: "trip",
      elevated: ["slowBackends"],
    });
  });

  test("compressor-thrash signal (decompressions/s) trips the detector", () => {
    const d = createOnsetDetector();
    const thrash = sample({ decompressionsPerSec: 240_000 }); // the 07-11 freezes
    d.feed(thrash, T, CADENCE);
    d.feed(thrash, T, CADENCE);
    expect(d.feed(thrash, T, CADENCE)).toMatchObject({
      kind: "trip",
      elevated: ["decompressionsPerSec"],
    });
  });

  test("null/absent decompressions (stale or pre-cutover host line) is neither elevated nor blocking calm", () => {
    const d = createOnsetDetector();
    // Absent (old persisted samples) and explicit null (stale host line) both
    // read as "no signal this tick".
    expect(d.feed(sample({ decompressionsPerSec: undefined }), T, CADENCE)).toBeNull();
    expect(d.feed(sample({ decompressionsPerSec: null }), T, CADENCE)).toBeNull();
    expect(d.tripped).toBe(false);
    // And during cooldown a null reading counts as calm on that axis.
    const thrash = sample({ decompressionsPerSec: 300_000 });
    d.feed(thrash, T, CADENCE);
    d.feed(thrash, T, CADENCE);
    d.feed(thrash, T, CADENCE); // trip
    const stale = sample({ decompressionsPerSec: null });
    expect(d.feed(stale, T, CADENCE)).toBeNull(); // calm 1/2
    expect(d.feed(stale, T, CADENCE)).toMatchObject({ kind: "clear" });
  });

  test("a pg-unreadable tick (null locks) is calm on the locks axis", () => {
    const d = createOnsetDetector();
    d.feed(hot, T, CADENCE);
    d.feed(hot, T, CADENCE);
    d.feed(hot, T, CADENCE); // trip
    const pgDown = sample({
      pgLocksWaiting: null,
      pgActiveBackends: null,
      pgTotalBackends: null,
      pgWaitEvents: null,
      pgBlkReadDeltaMs: null,
    });
    expect(d.feed(pgDown, T, CADENCE)).toBeNull(); // calm 1/2
    expect(d.feed(pgDown, T, CADENCE)).toMatchObject({ kind: "clear" });
  });

  test("load alone never trips: it is context, not a duress signal", () => {
    // Load per core 3 — twice the old 1.5 limit — with every real signal calm.
    const d = createOnsetDetector();
    const load = sample({ loadAvg1: 3 * 18 });
    for (let i = 0; i < 10; i++) expect(d.feed(load, T, CADENCE)).toBeNull();
    expect(d.tripped).toBe(false);
    const at = signalsAt(load, T);
    expect(at.readings.loadRatio).toBe(3);
    expect(at.elevated).toEqual([]);
    expect(at.allCalm).toBe(true);
  });

  test("seeded-tripped detector (latch adoption) clears without ever tripping", () => {
    const d = createOnsetDetector({ tripped: true });
    expect(d.tripped).toBe(true);
    expect(d.feed(calm, T, CADENCE)).toBeNull(); // calm 1/2
    expect(d.feed(calm, T, CADENCE)).toMatchObject({ kind: "clear" });
    expect(d.tripped).toBe(false);
  });
});

describe("signalsAt", () => {
  test("a signal between its clear and trip limits holds the episode without being elevated", () => {
    // 4 ungranted locks: under the 5 trip limit, at least the 3 clear limit.
    const between = signalsAt(sample({ pgLocksWaiting: 4 }), T);
    expect(between.elevated).toEqual([]);
    expect(between.holding).toEqual(["locksWaiting"]);
    expect(between.allCalm).toBe(false);

    const hotAt = signalsAt(sample({ pgLocksWaiting: 8 }), T);
    expect(hotAt.elevated).toEqual(["locksWaiting"]);
    expect(hotAt.holding).toEqual(["locksWaiting"]);

    const calm = signalsAt(sample({ pgLocksWaiting: 1 }), T);
    expect(calm.holding).toEqual([]);
    expect(calm.allCalm).toBe(true);
  });
});
