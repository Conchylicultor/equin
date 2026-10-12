import { describe, expect, it } from "bun:test";
import { emptyScore } from "@plugins/apps/plugins/sonata/plugins/score/core";
import type { Score } from "@plugins/apps/plugins/sonata/plugins/score/core";
import { barNotches } from "./notches";

/** A 4/4 score whose content spans `[0, end)`. */
function scoreTo(end: number, pickupBeats?: number): Score {
  return {
    ...emptyScore(),
    meta: pickupBeats === undefined ? {} : { pickupBeats },
    notes: [
      {
        id: "n",
        track: "t",
        pitch: 60,
        start: 0,
        duration: end,
        velocity: 100,
      },
    ],
  };
}

describe("barNotches", () => {
  it("is empty for an empty score", () => {
    expect(barNotches(emptyScore())).toEqual([]);
  });

  it("skips the first bar line and the one at the song's end", () => {
    // 6 bars of 4/4: lines at 4, 8, …, 20 — not 0 (left edge) nor 24 (end).
    expect(barNotches(scoreTo(24)).map((n) => n.beat)).toEqual([
      4, 8, 12, 16, 20,
    ]);
  });

  it("marks every 4th bar strong", () => {
    const strong = barNotches(scoreTo(40))
      .filter((n) => n.strong)
      .map((n) => n.index);
    expect(strong).toEqual([4, 8]);
  });

  it("starts after a pickup bar", () => {
    expect(barNotches(scoreTo(9, 1)).map((n) => n.beat)).toEqual([1, 5]);
  });
});
