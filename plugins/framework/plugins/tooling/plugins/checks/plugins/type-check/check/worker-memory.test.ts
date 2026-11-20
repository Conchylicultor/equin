import { describe, expect, test } from "bun:test";
import {
  backstopTreePeak,
  combineVerdicts,
  heavyTreePeak,
  judgeBackstopWeight,
  judgeWorkerWeight,
  MIN_SAMPLES,
  type WorkerMemoryRecord,
} from "./worker-memory";

const C = { peakBytes: 7.0e9, units: 2, perUnitBytes: 3.6e9 };
// The 2026-11-13 heavy runs (worker + batches at once).
const MEASURED = [7.0e9, 6.7e9, 8.1e9, 6.7e9, 6.4e9, 6.7e9, 7.2e9, 6.9e9];

describe("heavyTreePeak", () => {
  const base: WorkerMemoryRecord = {
    t: "2026-11-13T16:00:00.000Z",
    worktree: "w",
    admission: "heavy",
    workerBytes: 2e9,
    batches: { count: 9, concurrentBytes: 5e9 },
  };
  test("a heavy batched run is the worker plus its batches at once", () => {
    expect(heavyTreePeak(base)).toBe(7e9);
    expect(heavyTreePeak({ ...base, admission: "escalated" })).toBe(7e9);
  });
  test("a light or unbatched run is not the run the weight is for", () => {
    expect(heavyTreePeak({ ...base, admission: "light" })).toBeNull();
    expect(heavyTreePeak({ ...base, batches: null })).toBeNull();
  });
  test("only a full-profile run judges the full weight; a record from before profiles was full", () => {
    expect(heavyTreePeak({ ...base, profile: "full" })).toBe(7e9);
    expect(heavyTreePeak({ ...base, profile: "one-unit" })).toBeNull();
  });
});

describe("judgeWorkerWeight", () => {
  test("the measured runs agree with the constants", () => {
    expect(judgeWorkerWeight(MEASURED, C)).toEqual({ ok: true });
  });
  test("too few runs is inconclusive, not a pass", () => {
    const r = judgeWorkerWeight(MEASURED.slice(0, MIN_SAMPLES - 1), C);
    expect(r).toMatchObject({ ok: false, inconclusive: true });
  });
  test("a heavier worker is fixed by re-deriving its peak alone", () => {
    const heavier = MEASURED.map((p) => p * 1.3); // mean ~9 GB
    expect(judgeWorkerWeight(heavier, C).ok).toBe(false);
    // Re-derived: 9 GB is 3 units of 3.6, 3.0 GB a unit — within the quantum.
    expect(
      judgeWorkerWeight(heavier, { ...C, peakBytes: 9.0e9, units: 3 }),
    ).toEqual({ ok: true });
  });
  test("the old maxRSS-sized peak would still pass, a far one fails", () => {
    expect(judgeWorkerWeight(MEASURED, { ...C, peakBytes: 7.2e9 }).ok).toBe(
      true,
    );
    const r = judgeWorkerWeight(MEASURED, { ...C, peakBytes: 10e9 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("TYPE_CHECK_WORKER_PEAK_BYTES");
  });
  test("a lighter worker flags the peak and the quantum, each on its own", () => {
    const r = judgeWorkerWeight(
      MEASURED.map((p) => p / 2),
      C,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain("TYPE_CHECK_WORKER_PEAK_BYTES is");
      expect(r.message).toContain("PER_UNIT_BYTES is");
    }
  });
});

describe("backstopTreePeak", () => {
  const dual: WorkerMemoryRecord = {
    t: "2026-11-20T16:00:00.000Z",
    worktree: "main",
    admission: "heavy",
    profile: "full",
    mode: "dual",
    workerBytes: 2e9,
    batches: { count: 9, concurrentBytes: 5e9 },
    fullCheckBytes: 11e9,
  };
  test("the larger phase beside the worker: the oracle, or the batches", () => {
    expect(backstopTreePeak(dual)).toBe(13e9);
    expect(backstopTreePeak({ ...dual, fullCheckBytes: 1e9 })).toBe(7e9);
    expect(backstopTreePeak({ ...dual, batches: null })).toBe(13e9);
  });
  test("only a dual run with its oracle measured", () => {
    expect(backstopTreePeak({ ...dual, mode: "keyed" })).toBeNull();
    const { fullCheckBytes: _, ...noOracle } = dual;
    expect(backstopTreePeak(noOracle)).toBeNull();
  });
  test("a dual run's batched phase still counts toward the worker's weight", () => {
    expect(heavyTreePeak(dual)).toBe(7e9);
  });
});

describe("judgeBackstopWeight", () => {
  const PEAKS = [12e9, 13e9, 12.5e9, 13.5e9, 12e9];
  test("agrees within the tolerance", () => {
    expect(judgeBackstopWeight(PEAKS, 12.6e9)).toEqual({ ok: true });
  });
  test("an under-booked backstop fails, naming its constant", () => {
    const r = judgeBackstopWeight(PEAKS, 7.0e9);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("TYPE_CHECK_BACKSTOP_PEAK_BYTES");
  });
  test("too few dual runs is inconclusive", () => {
    expect(judgeBackstopWeight(PEAKS.slice(0, 2), 12.6e9)).toMatchObject({
      ok: false,
      inconclusive: true,
    });
  });
});

describe("combineVerdicts", () => {
  test("a real failure wins over an inconclusive one", () => {
    const r = combineVerdicts([
      { ok: false, inconclusive: true, message: "few" },
      { ok: false, message: "stale" },
    ]);
    expect(r).toEqual({ ok: false, message: "stale" });
  });
  test("a judged pass is not hidden by a weight still short of samples", () => {
    expect(
      combineVerdicts([
        { ok: true },
        { ok: false, inconclusive: true, message: "few" },
      ]),
    ).toEqual({ ok: true });
    expect(combineVerdicts([{ ok: true }, { ok: true }])).toEqual({ ok: true });
  });
  test("inconclusive only when no weight could be judged", () => {
    expect(
      combineVerdicts([
        { ok: false, inconclusive: true, message: "a" },
        { ok: false, inconclusive: true, message: "b" },
      ]),
    ).toEqual({ ok: false, inconclusive: true, message: "a\nb" });
  });
});
