import { describe, expect, test } from "bun:test";
import { NOTE_PULL, playheadPath } from "./anchors";

const bar = { startBeat: 0, endBeat: 4, startX: 0, endX: 100 };
const blend = (note: number, steady: number) =>
  NOTE_PULL * note + (1 - NOTE_PULL) * steady;

describe("playheadPath", () => {
  test("one point per beat at its leftmost x, blended toward constant speed", () => {
    expect(
      playheadPath(
        [
          { beat: 2, x: 60 },
          { beat: 0, x: 4 },
          { beat: 2, x: 52 },
        ],
        [bar],
      ),
    ).toEqual([
      { beat: 0, x: blend(4, 0) },
      { beat: 2, x: blend(52, 50) },
      { beat: 4, x: 100 },
    ]);
  });

  test("never stops: speed stays above NOTE_PULL's share of the measure average", () => {
    // A long note squeezed between busy ones, and a displaced notehead.
    const path = playheadPath(
      [
        { beat: 0, x: 10 },
        { beat: 0.25, x: 30 },
        { beat: 0.5, x: 25 },
        { beat: 0.75, x: 50 },
        { beat: 1, x: 70 },
        { beat: 3, x: 75 },
      ],
      [bar],
    );
    const average = (bar.endX - bar.startX) / (bar.endBeat - bar.startBeat);
    for (let i = 1; i < path.length; i++) {
      const speed =
        (path[i]!.x - path[i - 1]!.x) / (path[i]!.beat - path[i - 1]!.beat);
      expect(speed).toBeGreaterThanOrEqual((1 - NOTE_PULL) * average - 1e-9);
    }
  });

  test("measures chain in order and the path ends on the last one's end", () => {
    const path = playheadPath(
      [
        { beat: 0, x: 0 },
        { beat: 4, x: 110 },
      ],
      [bar, { startBeat: 4, endBeat: 8, startX: 110, endX: 200 }],
    );
    expect(path.map((p) => p.beat)).toEqual([0, 4, 8]);
    expect(path.at(-1)).toEqual({ beat: 8, x: 200 });
  });
});
