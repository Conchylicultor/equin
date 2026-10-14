import { describe, expect, it } from "bun:test";
import { barBeatsAt, cycleBeats, cycleStart } from "./loop-cycle";
import { emptyScore } from "./helpers";
import type { LoopCycle, Score } from "./types";

describe("cycle geometry", () => {
  it("an iteration is the rest then the body", () => {
    const cycle: LoopCycle = { start: 8, end: 16, rest: 4 };
    expect(cycleStart(cycle)).toBe(4);
    expect(cycleBeats(cycle)).toBe(12);
  });
});

describe("barBeatsAt", () => {
  it("reads the meter in force at the beat", () => {
    const s: Score = {
      ...emptyScore(),
      timeSigMap: [
        { beat: 0, numerator: 4, denominator: 4 },
        { beat: 8, numerator: 6, denominator: 8 },
      ],
    };
    expect(barBeatsAt(s, 0)).toBe(4);
    expect(barBeatsAt(s, 7.9)).toBe(4);
    expect(barBeatsAt(s, 8)).toBe(3);
    expect(barBeatsAt(emptyScore(), 3)).toBe(4);
  });
});
