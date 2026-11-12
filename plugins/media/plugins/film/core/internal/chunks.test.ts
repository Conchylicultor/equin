import { describe, expect, test } from "bun:test";
import {
  defaultWorkers,
  frameCount,
  frameTime,
  splitFrames,
  type FrameRange,
} from "./chunks";

/** The ranges are contiguous, in order, non-empty and cover [0, frames). */
function expectPartition(ranges: FrameRange[], frames: number): void {
  expect(ranges[0]?.start).toBe(0);
  expect(ranges.at(-1)?.end).toBe(frames);
  ranges.forEach((r, k) => {
    expect(r.end).toBeGreaterThan(r.start);
    if (k > 0) expect(r.start).toBe((ranges[k - 1] as FrameRange).end);
  });
}

describe("splitFrames", () => {
  test("partitions the frames exactly, sizes within one frame", () => {
    for (const frames of [1, 2, 7, 60, 719, 720, 9660, 9661]) {
      for (const workers of [1, 2, 3, 6, 7, 16, 1000]) {
        const ranges = splitFrames(frames, workers);
        expectPartition(ranges, frames);
        expect(ranges.length).toBe(Math.min(workers, frames));
        const sizes = ranges.map((r) => r.end - r.start);
        expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
        // Longer ranges first.
        expect([...sizes].sort((a, b) => b - a)).toEqual(sizes);
      }
    }
  });

  test("one worker is the serial render", () => {
    expect(splitFrames(720, 1)).toEqual([{ start: 0, end: 720 }]);
  });

  test("an even split", () => {
    expect(splitFrames(720, 3)).toEqual([
      { start: 0, end: 240 },
      { start: 240, end: 480 },
      { start: 480, end: 720 },
    ]);
  });

  test("an uneven split puts the extra frames first", () => {
    expect(splitFrames(10, 4)).toEqual([
      { start: 0, end: 3 },
      { start: 3, end: 6 },
      { start: 6, end: 8 },
      { start: 8, end: 10 },
    ]);
  });

  test("never a range under minFrames (unless the whole render is)", () => {
    expect(splitFrames(300, 8, 120)).toEqual([
      { start: 0, end: 150 },
      { start: 150, end: 300 },
    ]);
    expect(splitFrames(50, 8, 120)).toEqual([{ start: 0, end: 50 }]);
    for (const frames of [120, 239, 240, 1000, 9660]) {
      const ranges = splitFrames(frames, 6, 120);
      expectPartition(ranges, frames);
      for (const r of ranges)
        expect(r.end - r.start).toBeGreaterThanOrEqual(120);
    }
  });

  test("refuses a bad input", () => {
    expect(() => splitFrames(0, 4)).toThrow();
    expect(() => splitFrames(10.5, 4)).toThrow();
    expect(() => splitFrames(10, 0)).toThrow();
    expect(() => splitFrames(10, 2.5)).toThrow();
    expect(() => splitFrames(10, 2, 0)).toThrow();
  });
});

describe("frameTime / frameCount", () => {
  test("a chunk's frames show the serial render's instants", () => {
    const from = 3.25;
    const fps = 60;
    const n = frameCount(161.3, fps);
    expect(n).toBe(9678);
    const serial = Array.from({ length: n }, (_, i) => frameTime(from, i, fps));
    const chunked = splitFrames(n, 7).flatMap((r) =>
      Array.from({ length: r.end - r.start }, (_, j) =>
        frameTime(from, r.start + j, fps),
      ),
    );
    // Bit-identical: the same expression on the same frame index.
    expect(chunked).toEqual(serial);
  });

  test("refuses an empty render", () => {
    expect(() => frameCount(0, 60)).toThrow();
    expect(() => frameCount(1, 0)).toThrow();
  });
});

describe("defaultWorkers", () => {
  test("at least one, grows with the cores", () => {
    expect(defaultWorkers(1)).toBe(1);
    expect(defaultWorkers(2)).toBe(1);
    expect(defaultWorkers(18)).toBeGreaterThan(1);
    expect(defaultWorkers(32)).toBeGreaterThanOrEqual(defaultWorkers(18));
  });
});
