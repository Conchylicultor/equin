import { describe, expect, it } from "bun:test";
import { SMOOTH_CLOCK_MAX_SLEW, createSmoothClockModel } from "./smooth-clock";

/** Readings the way the IFrame API gives them: a post every `everyMs`, read each frame. */
function feed(
  model: ReturnType<typeof createSmoothClockModel>,
  fromMs: number,
  toMs: number,
  truth: (ms: number) => number,
  everyMs: number,
): number[] {
  const out: number[] = [];
  let posted = truth(fromMs);
  for (let ms = fromMs; ms <= toMs; ms += 16) {
    if (Math.floor(ms / everyMs) !== Math.floor((ms - 16) / everyMs)) {
      posted = truth(ms);
    }
    model.observe(posted, ms, 1);
    out.push(model.at(ms)!);
  }
  return out;
}

describe("createSmoothClockModel", () => {
  it("is null before a reading, and starts on the first one", () => {
    const m = createSmoothClockModel();
    expect(m.at(0)).toBeNull();
    m.observe(10, 1000, 1);
    expect(m.at(1000)).toBe(10);
    expect(m.at(1500)).toBeCloseTo(10.5, 9);
  });

  it("runs at the rate between readings", () => {
    const m = createSmoothClockModel();
    m.observe(10, 0, 2);
    expect(m.at(1000)).toBeCloseTo(12, 9);
  });

  it("slews toward a small disagreement instead of jumping, never faster than the budget", () => {
    const m = createSmoothClockModel();
    m.observe(0, 0, 1);
    // At 1 s the player says 1.04 s: 40 ms ahead.
    m.observe(1.04, 1000, 1);
    expect(m.at(1000)).toBeCloseTo(1, 9);
    // Half a second later the clock has absorbed at most 5 % of 0.5 s.
    expect(m.at(1500)).toBeCloseTo(1.5 + SMOOTH_CLOCK_MAX_SLEW * 0.5, 9);
    // And it stops slewing once absorbed: 0.8 s later the 40 ms is all in.
    expect(m.at(2000)).toBeCloseTo(2.04, 9);
    expect(m.at(3000)).toBeCloseTo(3.04, 9);
  });

  it("snaps on a jump (a seek) and on a rate change", () => {
    const m = createSmoothClockModel();
    m.observe(0, 0, 1);
    m.observe(30, 1000, 1);
    expect(m.at(1000)).toBe(30);
    m.observe(30.5, 1500, 0.5);
    expect(m.at(1500)).toBe(30.5);
    expect(m.at(2500)).toBeCloseTo(31, 9);
  });

  it("ignores a repeated reading (no news), and reset forgets", () => {
    const m = createSmoothClockModel();
    m.observe(5, 0, 1);
    m.observe(5, 1000, 1);
    expect(m.at(1000)).toBeCloseTo(6, 9);
    m.reset();
    expect(m.at(1000)).toBeNull();
  });

  it("turns stepped readings into a smooth, monotonic clock near the truth", () => {
    const m = createSmoothClockModel();
    // The player posts every 250 ms, each post 20–60 ms stale (its lag jitters).
    const lag = (ms: number) => 0.02 + 0.04 * ((Math.sin(ms / 377) + 1) / 2);
    const out = feed(m, 0, 20_000, (ms) => ms / 1000 - lag(ms), 250);
    let worstStep = 0;
    for (let i = 1; i < out.length; i++) {
      const step = out[i]! - out[i - 1]!;
      expect(step).toBeGreaterThan(0);
      worstStep = Math.max(worstStep, Math.abs(step - 0.016));
    }
    // Frame-to-frame the clock never jumps by more than the slew budget.
    expect(worstStep).toBeLessThanOrEqual(SMOOTH_CLOCK_MAX_SLEW * 0.016 + 1e-9);
    // And it stays within the lag's spread of the truth.
    const last = out.at(-1)!;
    expect(Math.abs(last - 20)).toBeLessThan(0.1);
  });
});
