import { describe, expect, it } from "bun:test";
import {
  LoopCandidateSchema,
  type LoopCandidate,
} from "@plugins/apps/plugins/chord/plugins/song-index/core";
import { dealLoop } from "./deal";
import { gridBoxes, roundFromCandidate, type Round } from "./round";

type Alignment = LoopCandidate["alignment"];

// Tokens used below.
const I = "0:4-3/0";
const IV = "5:4-3/0";
const V = "7:4-3/0";

type ChordFixture = { beat: number; duration: number; token: string | null };

/** 1 s per beat, beat 1 at 10 s: beat b is at 9 + b seconds. */
const ONE_SECOND_PER_BEAT: Alignment = {
  kind: "beat-times",
  beats: [1, 33],
  times: [10, 42],
};

/**
 * A loop candidate as `find` returns it: `chords` are the section's chords
 * overlapping the window. `chordCount` defaults to the sounding ones among them.
 */
function candidate(fixture: {
  chords: ChordFixture[];
  startBeat: number;
  endBeat: number;
  beatsPerBar?: number;
  beatUnit?: number;
  keyTonic?: string;
  alignment?: Alignment;
  videoDurationSeconds?: number | null;
  chordCount?: number;
}): LoopCandidate {
  const sounding = fixture.chords.filter((c) => c.token !== null);
  return LoopCandidateSchema.parse({
    sectionId: "abc_123",
    artist: "Artist",
    song: "Song",
    sectionName: "Chorus",
    videoId: "X1Fqn9du7xo",
    videoDurationSeconds: fixture.videoDurationSeconds ?? null,
    videoStatus: "unknown",
    alignment: fixture.alignment ?? ONE_SECOND_PER_BEAT,
    window: {
      shape: "bars-4",
      startBeat: fixture.startBeat,
      endBeat: fixture.endBeat,
      bars: 4,
      beatsPerBar: fixture.beatsPerBar ?? 4,
      beatUnit: fixture.beatUnit ?? 4,
      keyTonic: fixture.keyTonic ?? "C",
      keyMode: "major",
      chordTokens: [...new Set(sounding.map((c) => c.token))],
      features: [],
      chordCount: fixture.chordCount ?? sounding.length,
      changeCount: 0,
      hasRest: fixture.chords.some((c) => c.token === null),
      startsOnChange: sounding.some((c) => c.beat === fixture.startBeat),
      rich: false,
    },
    chords: fixture.chords.map((c) => ({
      root: 1,
      beat: c.beat,
      duration: c.duration,
      type: 5,
      inversion: 0,
      applied: 0,
      adds: [],
      omits: [],
      alterations: [],
      suspensions: [],
      borrowed: null,
      isRest: c.token === null,
      pedal: null,
      alternate: "",
      token: c.token,
    })),
  });
}

function roundOf(
  c: LoopCandidate,
  videoDurationSeconds: number | null = null,
): Round {
  const result = roundFromCandidate(c, { videoDurationSeconds });
  if (result.kind !== "round")
    throw new Error(`expected a round, got ${result.kind}`);
  return result.round;
}

/** The boxes as [token, startBeat, endBeat, gridStart, gridSpan]. */
const boxesOf = (round: Round) =>
  round.boxes.map((b): [string, number, number, number, number] => [
    b.token,
    b.startBeat,
    b.endBeat,
    b.gridStart,
    b.gridSpan,
  ]);

describe("roundFromCandidate — boxes", () => {
  // Window [5, 21) in 4/4: a I ringing in from beat 3, a IV, a rest, then V
  // twice, the second running past the window's end.
  const round = roundOf(
    candidate({
      startBeat: 5,
      endBeat: 21,
      keyTonic: "G",
      chords: [
        { beat: 3, duration: 4, token: I },
        { beat: 7, duration: 4, token: IV },
        { beat: 11, duration: 2, token: null },
        { beat: 13, duration: 4, token: V },
        { beat: 17, duration: 6, token: V },
      ],
    }),
  );

  it("clips a chord ringing in to the window's start", () => {
    expect(boxesOf(round)[0]).toEqual([I, 5, 7, 0, 2]);
  });

  it("makes no box for a rest, leaving a gap on the grid", () => {
    expect(boxesOf(round)[1]).toEqual([IV, 7, 11, 2, 4]);
    expect(boxesOf(round)[2]).toEqual([V, 13, 17, 8, 4]);
  });

  it("never merges a repeated chord, and clips one running past the end", () => {
    expect(boxesOf(round)[3]).toEqual([V, 17, 21, 12, 4]);
    expect(round.boxes.map((b) => b.position)).toEqual([0, 1, 2, 3]);
  });

  it("places boxes and the loop in video seconds", () => {
    expect(round.boxes.map((b) => [b.startSec, b.endSec])).toEqual([
      [14, 16],
      [16, 20],
      [22, 26],
      [26, 30],
    ]);
    expect(round.loop).toEqual({ startSec: 14, endSec: 30 });
  });

  it("carries the loop's identity, grid and key", () => {
    expect(round).toMatchObject({
      sectionId: "abc_123",
      videoId: "X1Fqn9du7xo",
      shape: "bars-4",
      startBeat: 5,
      keyTonicPc: 7,
      grid: { beats: 16, beatsPerBar: 4 },
    });
  });

  it("orders boxes by beat whatever the order it is given", () => {
    const shuffled = roundOf(
      candidate({
        startBeat: 1,
        endBeat: 17,
        chords: [
          { beat: 9, duration: 8, token: V },
          { beat: 1, duration: 8, token: I },
        ],
      }),
    );
    expect(boxesOf(shuffled)).toEqual([
      [I, 1, 9, 0, 8],
      [V, 9, 17, 8, 8],
    ]);
  });

  it("uses the index's overlap rule: a chord ending on the window's start is not in it", () => {
    const round = roundOf(
      candidate({
        startBeat: 5,
        endBeat: 21,
        chordCount: 1,
        chords: [
          { beat: 1, duration: 4, token: IV },
          { beat: 5, duration: 16, token: I },
        ],
      }),
    );
    expect(boxesOf(round)).toEqual([[I, 5, 21, 0, 16]]);
  });

  it("refuses a window whose sounding chords the index counted differently", () => {
    expect(() =>
      roundFromCandidate(
        candidate({
          startBeat: 1,
          endBeat: 17,
          chordCount: 3,
          chords: [{ beat: 1, duration: 16, token: I }],
        }),
        { videoDurationSeconds: null },
      ),
    ).toThrow("the index counted 3");
  });
});

describe("roundFromCandidate — meters", () => {
  it("lays a 3/4 window on a 12-beat grid of 3-beat bars", () => {
    const round = roundOf(
      candidate({
        startBeat: 1,
        endBeat: 13,
        beatsPerBar: 3,
        chords: [
          { beat: 1, duration: 3, token: I },
          { beat: 4, duration: 3, token: IV },
          { beat: 7, duration: 3, token: V },
          { beat: 10, duration: 3, token: I },
        ],
      }),
    );
    expect(round.grid).toEqual({ beats: 12, beatsPerBar: 3 });
    expect(round.boxes.map((b) => [b.gridStart, b.gridSpan])).toEqual([
      [0, 3],
      [3, 3],
      [6, 3],
      [9, 3],
    ]);
  });

  it("lays a 6/8 window on a 24-beat grid of 6-beat bars", () => {
    const round = roundOf(
      candidate({
        startBeat: 7,
        endBeat: 31,
        beatsPerBar: 6,
        beatUnit: 8,
        chords: [
          { beat: 7, duration: 6, token: I },
          { beat: 13, duration: 12, token: IV },
          { beat: 25, duration: 9, token: V },
        ],
      }),
    );
    expect(round.grid).toEqual({ beats: 24, beatsPerBar: 6 });
    expect(boxesOf(round)).toEqual([
      [I, 7, 13, 0, 6],
      [IV, 13, 25, 6, 12],
      [V, 25, 31, 18, 6],
    ]);
    expect(round.loop).toEqual({ startSec: 16, endSec: 40 });
  });
});

describe("roundFromCandidate — alignments", () => {
  const chords = [
    { beat: 1, duration: 8, token: I },
    { beat: 9, duration: 8, token: V },
  ];

  it("reads a per-beat alignment piecewise", () => {
    const round = roundOf(
      candidate({
        startBeat: 1,
        endBeat: 17,
        chords,
        alignment: { kind: "beat-times", beats: [1, 9, 17], times: [0, 4, 12] },
      }),
    );
    expect(round.boxes.map((b) => [b.startSec, b.endSec])).toEqual([
      [0, 4],
      [4, 12],
    ]);
  });

  const fraction: Alignment = {
    kind: "video-fraction",
    start: 0.1,
    end: 0.6,
    endBeat: 33,
  };

  it("reads a video-fraction alignment against the candidate's duration", () => {
    // 200 s: beat 1 at 20 s, beat 33 at 120 s, 3.125 s per beat.
    const round = roundOf(
      candidate({
        startBeat: 1,
        endBeat: 17,
        chords,
        alignment: fraction,
        videoDurationSeconds: 200,
      }),
    );
    expect(round.loop).toEqual({ startSec: 20, endSec: 70 });
    expect(round.boxes.map((b) => [b.startSec, b.endSec])).toEqual([
      [20, 45],
      [45, 70],
    ]);
  });

  it("prefers the player's duration to the candidate's", () => {
    const c = candidate({
      startBeat: 1,
      endBeat: 17,
      chords,
      alignment: fraction,
      videoDurationSeconds: 200,
    });
    expect(roundOf(c, 100).loop).toEqual({ startSec: 10, endSec: 35 });
  });

  it("uses the player's duration when the candidate has none", () => {
    const c = candidate({
      startBeat: 1,
      endBeat: 17,
      chords,
      alignment: fraction,
    });
    expect(roundOf(c, 100).loop).toEqual({ startSec: 10, endSec: 35 });
  });

  it("needs a duration when neither the player nor the candidate has one", () => {
    const c = candidate({
      startBeat: 1,
      endBeat: 17,
      chords,
      alignment: fraction,
    });
    expect(roundFromCandidate(c, { videoDurationSeconds: null })).toEqual({
      kind: "needs-duration",
    });
  });

  it("refuses a duration that is not a length", () => {
    const c = candidate({
      startBeat: 1,
      endBeat: 17,
      chords,
      alignment: fraction,
    });
    expect(() => roundFromCandidate(c, { videoDurationSeconds: 0 })).toThrow(
      "cannot be read",
    );
  });

  it("does not need a duration for a beat-times alignment", () => {
    const c = candidate({ startBeat: 1, endBeat: 17, chords });
    expect(roundFromCandidate(c, { videoDurationSeconds: null }).kind).toBe(
      "round",
    );
  });

  it("refuses a candidate with no alignment", () => {
    const c = candidate({
      startBeat: 1,
      endBeat: 17,
      chords,
      alignment: { kind: "none" },
    });
    expect(() => roundFromCandidate(c, { videoDurationSeconds: 200 })).toThrow(
      "no alignment",
    );
  });
});

describe("dealLoop — the asked boxes, decided once", () => {
  // Window [1, 17): I, IV, V, I, one per bar.
  const loop = candidate({
    startBeat: 1,
    endBeat: 17,
    chords: [
      { beat: 1, duration: 4, token: I },
      { beat: 5, duration: 4, token: IV },
      { beat: 9, duration: 4, token: V },
      { beat: 13, duration: 4, token: I },
    ],
  });
  const practised = new Set(loop.window.chordTokens);

  it("reads the boxes on the beat grid alone, before the video's length is known", () => {
    const videoFraction = candidate({
      startBeat: 1,
      endBeat: 17,
      alignment: { kind: "video-fraction", start: 0.1, end: 0.9, endBeat: 33 },
      chords: [{ beat: 1, duration: 16, token: I }],
    });
    expect(
      roundFromCandidate(videoFraction, { videoDurationSeconds: null }).kind,
    ).toBe("needs-duration");
    expect(gridBoxes(videoFraction).map((b) => b.gridStart)).toEqual([0]);
  });

  it("asks by the blanks setting and carries it", () => {
    expect(dealLoop(loop, { practised, blanks: "all" })).toMatchObject({
      asked: [0, 1, 2, 3],
      blanks: "all",
    });
    expect(dealLoop(loop, { practised, blanks: "half" }).asked).toEqual([2, 3]);
    const random = dealLoop(loop, {
      practised,
      blanks: "random",
      random: () => 0,
    });
    expect(random.asked).toEqual([0, 1]);
  });

  it("matches the round's boxes", () => {
    const round = roundOf(loop);
    expect(
      gridBoxes(loop).map((b) => [b.position, b.token, b.gridStart]),
    ).toEqual(round.boxes.map((b) => [b.position, b.token, b.gridStart]));
  });

  it("throws for a loop holding no practised chord", () => {
    expect(() =>
      dealLoop(loop, { practised: new Set(), blanks: "all" }),
    ).toThrow(/no practised chord/);
  });
});
