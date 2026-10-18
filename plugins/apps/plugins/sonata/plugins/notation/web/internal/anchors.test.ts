import { describe, expect, test } from "bun:test";
import { playheadPath } from "./anchors";

describe("playheadPath", () => {
  test("one point per beat, at its leftmost x, ending on the system's end", () => {
    expect(
      playheadPath(
        [
          { beat: 1, x: 60 },
          { beat: 0, x: 20 },
          { beat: 1, x: 52 },
        ],
        { beat: 2, x: 100 },
      ),
    ).toEqual([
      { beat: 0, x: 20 },
      { beat: 1, x: 52 },
      { beat: 2, x: 100 },
    ]);
  });

  test("x never goes back", () => {
    expect(
      playheadPath(
        [
          { beat: 0, x: 30 },
          { beat: 0.5, x: 24 },
          { beat: 1, x: 40 },
        ],
        { beat: 2, x: 35 },
      ).map((p) => p.x),
    ).toEqual([30, 30, 40, 40]);
  });

  test("onsets at or past the end are dropped", () => {
    expect(playheadPath([{ beat: 4, x: 90 }], { beat: 4, x: 100 })).toEqual([
      { beat: 4, x: 100 },
    ]);
  });
});
