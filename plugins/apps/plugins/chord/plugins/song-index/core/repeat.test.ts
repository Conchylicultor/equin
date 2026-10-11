import { describe, expect, it } from "bun:test";
import { repeatPeriod, type LoopChord } from "./repeat";
import { ChordTokenSchema } from "./token";

const I = ChordTokenSchema.parse("0:4-3/0");
const IV = ChordTokenSchema.parse("5:4-3/0");
const V = ChordTokenSchema.parse("7:4-3/0");
const vi = ChordTokenSchema.parse("9:3-4/0");

/** Consecutive chords `each` beats long from beat 0. */
const run = (tokens: (typeof I)[], each: number): LoopChord[] =>
  tokens.map((token, i) => ({ start: i * each, end: (i + 1) * each, token }));

describe("repeatPeriod", () => {
  it("finds a progression played twice", () => {
    expect(repeatPeriod(run([I, V, vi, IV, I, V, vi, IV], 4), 32)).toBe(16);
  });

  it("finds the shortest pass", () => {
    expect(repeatPeriod(run([I, V, I, V], 4), 16)).toBe(8);
  });

  it("is the whole loop when it never repeats", () => {
    expect(repeatPeriod(run([I, IV, V, I], 4), 16)).toBe(16);
    // Same chords, other rhythm: not a replay.
    expect(
      repeatPeriod(
        [
          { start: 0, end: 4, token: I },
          { start: 4, end: 8, token: V },
          { start: 8, end: 10, token: I },
          { start: 10, end: 16, token: V },
        ],
        16,
      ),
    ).toBe(16);
  });

  it("does not take a held chord for a repeat", () => {
    expect(repeatPeriod(run([I], 16), 16)).toBe(16);
  });
});
