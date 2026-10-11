import { describe, expect, test } from "bun:test";
import { ChordTokenSchema } from "@plugins/apps/plugins/chord/plugins/song-index/core";
import { askedPositions, type AskedBox } from "./ask";

const token = (text: string) => ChordTokenSchema.parse(text);
const I = token("0:4-3/0");
const IV = token("5:4-3/0");
const V = token("7:4-3/0");
const vi = token("9:3-4/0");

/** A 16-beat loop: I, IV, V, I, one chord per bar. */
const LOOP: AskedBox[] = [
  { position: 0, token: I, gridStart: 0, gridSpan: 4 },
  { position: 1, token: IV, gridStart: 4, gridSpan: 4 },
  { position: 2, token: V, gridStart: 8, gridSpan: 4 },
  { position: 3, token: I, gridStart: 12, gridSpan: 4 },
];

const asked = (
  boxes: AskedBox[],
  over: Partial<Parameters<typeof askedPositions>[1]> = {},
) =>
  askedPositions(boxes, {
    windowBeats: 16,
    blanks: "all",
    practised: new Set([I, IV, V]),
    ...over,
  });

describe("askedPositions", () => {
  test("all: every box of a practised chord", () => {
    expect(asked(LOOP)).toEqual([0, 1, 2, 3]);
  });

  test("a chord only heard is always given, whatever the blanks", () => {
    const practised = new Set([IV, V]);
    expect(asked(LOOP, { practised })).toEqual([1, 2]);
    expect(asked(LOOP, { practised, blanks: "half" })).toEqual([2]);
  });

  test("first: every practised box but the loop's first", () => {
    expect(asked(LOOP, { blanks: "first" })).toEqual([1, 2, 3]);
    // The first box not practised: nothing more is given.
    expect(
      asked(LOOP, { blanks: "first", practised: new Set([IV, V]) }),
    ).toEqual([1, 2]);
  });

  test("half: the practised boxes starting in the second half", () => {
    expect(asked(LOOP, { blanks: "half" })).toEqual([2, 3]);
  });

  test("random: half the practised boxes, rounded up, drawn by the given random", () => {
    // Always the first remaining box: the draw keeps the beat order's head.
    expect(asked(LOOP, { blanks: "random", random: () => 0 })).toEqual([0, 1]);
    // Always the last remaining box: 3 first, then (swapped into its place) 0.
    expect(asked(LOOP, { blanks: "random", random: () => 0.999 })).toEqual([
      0, 3,
    ]);
    // Three practised boxes: two asked.
    const practised = new Set([IV, V, I]);
    const three = LOOP.slice(0, 3);
    expect(
      asked(three, { blanks: "random", practised, random: () => 0 }),
    ).toHaveLength(2);
  });

  test("random: every draw is a set of distinct practised boxes", () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    };
    const practised = new Set([IV, V]);
    for (let i = 0; i < 50; i++) {
      const positions = asked(LOOP, { blanks: "random", practised, random });
      expect(positions).toHaveLength(1);
      expect([1, 2]).toContain(positions[0] ?? -1);
    }
  });

  test("never empty: half with nothing practised in the second half asks the last practised box", () => {
    expect(asked(LOOP, { blanks: "half", practised: new Set([IV]) })).toEqual([
      1,
    ]);
  });

  test("a chord that is not practised is never asked, and a round with none throws", () => {
    expect(asked(LOOP, { practised: new Set([vi, IV]) })).toEqual([1]);
    expect(() => asked(LOOP, { practised: new Set([vi]) })).toThrow(
      /no practised chord/,
    );
  });

  test("a window of no beats throws", () => {
    expect(() => asked(LOOP, { windowBeats: 0 })).toThrow(/positive number/);
  });

  describe("a loop that replays itself", () => {
    /** I–IV–V–vi, then the same again: 8 bars, 32 beats. */
    const TWICE: AskedBox[] = [I, IV, V, vi, I, IV, V, vi].map((t, i) => ({
      position: i,
      token: t,
      gridStart: i * 4,
      gridSpan: 4,
    }));
    const twice = (over: Partial<Parameters<typeof askedPositions>[1]>) =>
      asked(TWICE, {
        windowBeats: 32,
        practised: new Set([I, IV, V, vi]),
        ...over,
      });

    test("half: the second half of each pass, so the given pass is no answer key", () => {
      expect(twice({ blanks: "half" })).toEqual([2, 3, 6, 7]);
    });

    test("first: the first box of each pass is given, the rest asked", () => {
      expect(twice({ blanks: "first" })).toEqual([1, 2, 3, 5, 6, 7]);
    });

    test("random: the draw picks within one pass, and its replays follow", () => {
      expect(twice({ blanks: "random", random: () => 0 })).toEqual([
        0, 1, 4, 5,
      ]);
    });

    test("a replay in another rhythm is not a repeat", () => {
      const swung = TWICE.map((box) =>
        box.position === 7 ? { ...box, gridStart: 30, gridSpan: 2 } : box,
      );
      expect(
        asked(swung, {
          windowBeats: 32,
          blanks: "half",
          practised: new Set([I, IV, V, vi]),
        }),
      ).toEqual([4, 5, 6, 7]);
    });
  });
});
