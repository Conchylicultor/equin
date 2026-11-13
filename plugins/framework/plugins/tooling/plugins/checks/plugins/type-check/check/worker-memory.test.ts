import { describe, expect, test } from "bun:test";
import {
  heavyTreePeak,
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
