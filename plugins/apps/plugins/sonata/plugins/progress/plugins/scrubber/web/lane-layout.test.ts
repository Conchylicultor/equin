import { describe, expect, test } from "bun:test";
import {
  groupLabels,
  railSegments,
  segmentAt,
  segmentFill,
  snapBeat,
} from "./lane-layout";

describe("railSegments", () => {
  test("no chapters → one segment over the whole song, no gaps", () => {
    expect(railSegments([], 64)).toEqual([
      { start: 0, end: 64, from: 0, to: 1, gapBefore: false, gapAfter: false },
    ]);
  });

  test("sorted, clamped, empty spans dropped; gaps only between neighbours", () => {
    const segs = railSegments(
      [
        { start: 32, end: 80 },
        { start: -4, end: 32 },
        { start: 10, end: 10 },
      ],
      64,
    );
    expect(segs.map((s) => [s.start, s.end])).toEqual([
      [0, 32],
      [32, 64],
    ]);
    expect(segs.map((s) => [s.gapBefore, s.gapAfter])).toEqual([
      [false, true],
      [true, false],
    ]);
    expect(segs[1]!.from).toBe(0.5);
  });
});

describe("segmentFill / segmentAt", () => {
  const segs = [
    { start: 0, end: 8 },
    { start: 8, end: 16 },
  ];
  test("fill is clamped progress through the segment", () => {
    expect(segmentFill(segs[0]!, -1)).toBe(0);
    expect(segmentFill(segs[0]!, 4)).toBe(0.5);
    expect(segmentFill(segs[0]!, 12)).toBe(1);
    expect(segmentFill(segs[1]!, 4)).toBe(0);
  });
  test("segmentAt is half-open, the last segment holds the end", () => {
    expect(segmentAt(segs, 0)).toBe(0);
    expect(segmentAt(segs, 8)).toBe(1);
    expect(segmentAt(segs, 16)).toBe(1);
    expect(segmentAt(segs, 17)).toBe(-1);
  });
});

describe("groupLabels", () => {
  test("same-beat items fold into one group, ordered by contributor order", () => {
    const groups = groupLabels(
      [
        { beat: 32, order: 20, item: "G#m" },
        { beat: 0, order: 20, item: "B" },
        { beat: 32, order: 10, item: "Answer" },
        { beat: 0, order: 10, item: "Theme" },
      ],
      64,
    );
    expect(groups).toEqual([
      { beat: 0, end: 32, items: ["Theme", "B"] },
      { beat: 32, end: 64, items: ["Answer", "G#m"] },
    ]);
  });

  test("equal order keeps input order; a lone mid-section item gets its own group", () => {
    const groups = groupLabels(
      [
        { beat: 0, order: 0, item: "a" },
        { beat: 0, order: 0, item: "b" },
        { beat: 20, order: 5, item: "D" },
      ],
      48,
    );
    expect(groups).toEqual([
      { beat: 0, end: 20, items: ["a", "b"] },
      { beat: 20, end: 48, items: ["D"] },
    ]);
  });

  test("items outside [0, endBeat) are dropped", () => {
    expect(
      groupLabels(
        [
          { beat: -2, order: 0, item: "pre" },
          { beat: 48, order: 0, item: "end" },
        ],
        48,
      ),
    ).toEqual([]);
  });
});

describe("snapBeat", () => {
  test("snaps onto the nearest snap beat within 7px", () => {
    // 10 px per beat: 0.5 beat = 5px away → snaps.
    expect(snapBeat(31.5, [32, 40], 10)).toEqual({ beat: 32, snapped: true });
    expect(snapBeat(39.6, [32, 40], 10)).toEqual({ beat: 40, snapped: true });
  });
  test("stays put beyond the radius or with no snap beats", () => {
    expect(snapBeat(31, [32], 10)).toEqual({ beat: 31, snapped: false });
    expect(snapBeat(5, [], 10)).toEqual({ beat: 5, snapped: false });
  });
});
