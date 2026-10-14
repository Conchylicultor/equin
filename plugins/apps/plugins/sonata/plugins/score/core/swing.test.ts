import { describe, expect, test } from "bun:test";
import { swingBeat, swingScore } from "./swing";
import { emptyScore } from "./helpers";
import type { Note, Score } from "./types";

function note(start: number, duration: number): Note {
  return {
    id: `n${start}`,
    pitch: 60,
    start,
    duration,
    velocity: 80,
    track: "t",
  };
}

function scoreWith(notes: Note[], meta: Score["meta"]): Score {
  return { ...emptyScore(), meta, notes };
}

describe("swingBeat", () => {
  test("swung eighths at 2:1 put the off-beat on the last triplet", () => {
    const swing = { unit: 8, ratio: 2 } as const;
    expect(swingBeat(0, swing)).toBe(0);
    expect(swingBeat(0.5, swing)).toBeCloseTo(2 / 3);
    expect(swingBeat(1, swing)).toBe(1);
    expect(swingBeat(3.5, swing)).toBeCloseTo(3 + 2 / 3);
  });

  test("swung sixteenths swing inside each eighth", () => {
    const swing = { unit: 16, ratio: 2 } as const;
    expect(swingBeat(0.25, swing)).toBeCloseTo(1 / 3);
    expect(swingBeat(0.5, swing)).toBeCloseTo(0.5);
    expect(swingBeat(0.75, swing)).toBeCloseTo(0.5 + 1 / 3);
  });

  test("ratio 1 is the identity", () => {
    for (const b of [0, 0.25, 0.5, 0.8, 1.3]) {
      expect(swingBeat(b, { unit: 8, ratio: 1 })).toBeCloseTo(b);
    }
  });

  test("the grid is phased on the origin (first full bar after a pickup)", () => {
    const swing = { unit: 8, ratio: 2 } as const;
    // Pickup of half a beat: the bar line sits on 0.5, which stays put.
    expect(swingBeat(0.5, swing, 0.5)).toBeCloseTo(0.5);
    expect(swingBeat(1, swing, 0.5)).toBeCloseTo(0.5 + 2 / 3);
  });

  test("a non-positive ratio throws", () => {
    expect(() => swingBeat(0.5, { unit: 8, ratio: 0 })).toThrow();
  });
});

describe("swingScore", () => {
  test("no swing returns the same score", () => {
    const s = scoreWith([note(0.5, 0.5)], {});
    expect(swingScore(s)).toBe(s);
  });

  test("an eighth pair becomes long-short; on-beat notes stay", () => {
    const s = scoreWith([note(0, 0.5), note(0.5, 0.5), note(1, 1)], {
      swing: { unit: 8, ratio: 2 },
    });
    const [a, b, c] = swingScore(s).notes;
    expect(a!.start).toBe(0);
    expect(a!.duration).toBeCloseTo(2 / 3);
    expect(b!.start).toBeCloseTo(2 / 3);
    expect(b!.duration).toBeCloseTo(1 / 3);
    expect(c!.start).toBe(1);
    expect(c!.duration).toBe(1);
    // Notation stays straight: the input is untouched.
    expect(s.notes[1]!.start).toBe(0.5);
  });

  test("pedal changes swing with the notes", () => {
    const s: Score = {
      ...scoreWith([], { swing: { unit: 8, ratio: 2 } }),
      pedalEvents: [{ track: "t", beat: 0.5, down: true }],
    };
    expect(swingScore(s).pedalEvents[0]!.beat).toBeCloseTo(2 / 3);
  });
});
