import { describe, expect, test } from "bun:test";
import { createRubberBand } from "./rubber-band";

/** A wheel event: when it lands (ms) and its delta. */
type Wheel = [at: number, delta: number];

/** A trackpad momentum tail: one event per 60 Hz tick, each `decay`× the last. */
function momentum(first: number, decay: number): Wheel[] {
  const out: Wheel[] = [];
  for (let i = 0, d = first; Math.abs(d) >= 2; i += 1, d *= decay) {
    out.push([i * (1000 / 60), d]);
  }
  return out;
}

/**
 * Run the band over `wheels`, one frame every `frameMs(i)` ms, each frame
 * taking every event due by then (summed, as the detector does).
 */
function runFrames(
  wheels: Wheel[],
  frameMs: (i: number) => number,
  ms = 1500,
): number[] {
  const band = createRubberBand();
  const offsets: number[] = [];
  let next = 0;
  for (let i = 0, t = 0; t <= ms; i += 1) {
    const frame = frameMs(i);
    t += frame;
    let delta = 0;
    while (next < wheels.length && (wheels[next]?.[0] ?? Infinity) <= t) {
      delta += wheels[next]?.[1] ?? 0;
      next += 1;
    }
    band.frame(frame, delta, false);
    offsets.push(band.offset);
  }
  return offsets;
}

/** Run the band at a steady `hz`. */
function run(wheels: Wheel[], hz: number, ms = 1500): number[] {
  return runFrames(wheels, () => 1000 / hz, ms);
}

/**
 * How many times the motion changes direction, counting only steps of
 * `visible` px or more (the shake this guards against was ~2 px back and forth
 * every frame).
 */
function turns(offsets: number[], visible = 0.1): number {
  let count = 0;
  let dir = 0;
  for (let i = 1; i < offsets.length; i += 1) {
    const step = (offsets[i] ?? 0) - (offsets[i - 1] ?? 0);
    if (Math.abs(step) < visible) continue;
    const d = Math.sign(step);
    if (dir !== 0 && d !== dir) count += 1;
    dir = d;
  }
  return count;
}

describe("rubber band", () => {
  for (const hz of [60, 120, 144]) {
    test(`a momentum flick at ${hz} Hz goes out and back once, never shaking`, () => {
      const offsets = run(momentum(80, 0.9), hz);
      expect(turns(offsets)).toBe(1);
      expect(Math.min(...offsets)).toBeLessThan(-10);
    });
  }

  test("on a loaded machine (frames of 17–83 ms) the flick still does not shake", () => {
    // A fixed irregular cadence, as measured in a busy headless Chromium.
    const cadence = [17, 33, 17, 50, 83, 17, 67, 33, 17, 50];
    const offsets = runFrames(
      momentum(80, 0.9),
      (i) => cadence[i % cadence.length] ?? 17,
    );
    expect(turns(offsets, 0.5)).toBe(1);
  });

  test("a steady push at the end moves content up, and it comes back to rest", () => {
    const wheels: Wheel[] = Array.from({ length: 20 }, (_, i) => [i * 16.7, 8]);
    const offsets = run(wheels, 120);
    expect(turns(offsets)).toBe(1);
    expect(Math.min(...offsets)).toBeLessThan(-5);
    expect(offsets.at(-1)).toBe(0);
  });

  test("a push at the start moves content down", () => {
    const offsets = run(momentum(-60, 0.85), 120);
    expect(Math.max(...offsets)).toBeGreaterThan(10);
    expect(Math.min(...offsets)).toBe(0);
  });

  test("never stretches past its limit", () => {
    const wheels: Wheel[] = Array.from({ length: 60 }, (_, i) => [
      i * 16.7,
      400,
    ]);
    expect(Math.min(...run(wheels, 120))).toBeGreaterThan(-48);
  });

  test("the motion does not depend on the frame rate", () => {
    const at60 = run(momentum(80, 0.9), 60, 600);
    const at120 = run(momentum(80, 0.9), 120, 600);
    expect(Math.abs(Math.min(...at60) - Math.min(...at120))).toBeLessThan(2);
  });

  test("a held finger keeps the pull; release springs it back", () => {
    const band = createRubberBand();
    band.frame(16, 100, true);
    for (let i = 0; i < 60; i += 1) band.frame(16, 0, true);
    const held = band.offset;
    expect(held).toBeLessThan(-20);
    for (let i = 0; i < 120; i += 1) band.frame(16, 0, false);
    expect(band.atRest).toBe(true);
  });
});
