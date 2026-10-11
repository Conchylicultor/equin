import { describe, expect, it } from "bun:test";
import { deriveSection } from "./derive";
import {
  C_MAJOR,
  chord,
  progression,
  rest,
  section,
  windowsOf,
} from "./test-sections";

const starts = (windows: { startBeat: number }[]) =>
  windows.map((w) => w.startBeat);

describe("bars-4", () => {
  it("cuts 4/4 into one 4-bar window per bar start", () => {
    // 8 bars of I–IV–V–I, one chord per bar.
    const windows = windowsOf(
      deriveSection(section(progression([1, 4, 5, 1, 1, 4, 5, 1], 4))),
      "bars-4",
    );
    expect(starts(windows)).toEqual([1, 5, 9, 13, 17]);
    expect<unknown>(windows[0]).toEqual({
      shape: "bars-4",
      startBeat: 1,
      endBeat: 17,
      bars: 4,
      beatsPerBar: 4,
      beatUnit: 4,
      keyTonic: "C",
      keyMode: "major",
      chordTokens: ["0:4-3/0", "5:4-3/0", "7:4-3/0"],
      features: [],
      chordCount: 4,
      changeCount: 3,
      hasRest: false,
      startsOnChange: true,
      rich: true,
    });
  });

  it("follows the meter: 6/8 bars are 6 beats, 3/4 bars 3", () => {
    const sixEight = windowsOf(
      deriveSection(
        section(progression([1, 5, 6, 4, 1], 6), {
          meters: [{ beat: 1, numBeats: 6, beatUnit: 8 }],
        }),
      ),
      "bars-4",
    );
    expect(
      sixEight.map((w) => [w.startBeat, w.endBeat, w.beatsPerBar, w.beatUnit]),
    ).toEqual([
      [1, 25, 6, 8],
      [7, 31, 6, 8],
    ]);

    const threeFour = windowsOf(
      deriveSection(
        section(progression([1, 4, 5, 1, 6], 3), {
          meters: [{ beat: 1, numBeats: 3, beatUnit: 4 }],
        }),
      ),
      "bars-4",
    );
    expect(threeFour.map((w) => [w.startBeat, w.endBeat])).toEqual([
      [1, 13],
      [4, 16],
    ]);
  });

  it("cuts the bars at a meter change and never spans it", () => {
    // 5 bars of 4/4 (beats 1–20), then 4 bars of 3/4 (beats 21–32).
    const windows = windowsOf(
      deriveSection(
        section(
          [
            ...progression([1, 4, 5, 1, 6], 4),
            ...[21, 24, 27, 30].map((b) => chord(b, 3, { root: 2 })),
          ],
          {
            meters: [
              { beat: 1, numBeats: 4, beatUnit: 4 },
              { beat: 21, numBeats: 3, beatUnit: 4 },
            ],
          },
        ),
      ),
      "bars-4",
    );
    expect(windows.map((w) => [w.startBeat, w.endBeat, w.beatsPerBar])).toEqual(
      [
        [1, 17, 4],
        [5, 21, 4],
        [21, 33, 3],
      ],
    );
  });

  it("keeps a window inside one key", () => {
    // 8 bars; the key moves to G at bar 5 (beat 17).
    const windows = windowsOf(
      deriveSection(
        section(progression([1, 4, 5, 1, 1, 4, 5, 1], 4), {
          keys: [C_MAJOR, { beat: 17, tonic: "G", scale: "major" }],
        }),
      ),
      "bars-4",
    );
    expect(windows.map((w) => [w.startBeat, w.keyTonic])).toEqual([
      [1, "C"],
      [17, "G"],
    ]);
    // The token is relative to the key the chord is in: bar 5's I in G is still "0".
    expect<unknown>(windows[1]?.chordTokens).toEqual([
      "0:4-3/0",
      "5:4-3/0",
      "7:4-3/0",
    ]);
  });

  it("does not treat a repeat of the same key (other spelling) as a change", () => {
    const windows = windowsOf(
      deriveSection(
        section(progression([1, 4, 5, 1, 1, 4], 4), {
          keys: [
            { beat: 1, tonic: "F", scale: "major" },
            { beat: 9, tonic: "E#", scale: "major" },
          ],
        }),
      ),
      "bars-4",
    );
    expect(starts(windows)).toEqual([1, 5, 9]);
  });

  it("gives no window to a section shorter than 4 bars", () => {
    expect(
      windowsOf(deriveSection(section(progression([1, 4, 5], 4))), "bars-4"),
    ).toEqual([]);
  });

  it("records rests, gaps and where changes fall", () => {
    const windows = windowsOf(
      deriveSection(
        section([
          chord(1, 2, { root: 1 }),
          chord(3, 2, { root: 1 }), // same chord again: not a change
          rest(5, 4),
          chord(9, 6, { root: 5, type: 7 }), // rings into bar 4
          chord(15, 2, { root: 4, inversion: 1 }),
          // bar 5: nothing written until beat 19 → a gap
          chord(19, 2, { root: 1 }),
          chord(21, 4, { root: 1 }),
        ]),
      ),
      "bars-4",
    );
    expect(windows[0]).toMatchObject({
      startBeat: 1,
      chordTokens: ["0:4-3/0", "7:4-3-3/0", "5:4-3/1"],
      features: ["seventh", "inverted"],
      chordCount: 4,
      changeCount: 2,
      hasRest: true,
      startsOnChange: true,
    });
    expect(windows[2]).toMatchObject({
      startBeat: 9,
      endBeat: 25,
      chordTokens: ["7:4-3-3/0", "5:4-3/1", "0:4-3/0"],
      hasRest: true, // the gap at beats 17–19
      startsOnChange: true,
    });
    expect(windows[1]).toMatchObject({
      startBeat: 5,
      chordCount: 3,
      changeCount: 2, // V7 → IV, IV → I; the rest before the V7 is not a change
      hasRest: true,
      startsOnChange: false, // the window opens on the rest
    });
  });

  it("leaves out a window where nothing sounds", () => {
    const windows = windowsOf(
      deriveSection(
        section([...progression([1, 4], 4), rest(9, 16), chord(25, 4)]),
      ),
      "bars-4",
    );
    expect(starts(windows)).toEqual([1, 5, 13]);
  });
});

describe("phrase", () => {
  const phrases = (input: Parameters<typeof deriveSection>[0]) =>
    windowsOf(deriveSection(input), "phrase").map((w) => [
      w.startBeat,
      w.bars,
      w.rich,
    ]);
  const slow = { beat: 1, bpm: 60, swingFactor: 0, swingBeat: 0.5 };

  it("keeps 4 bars when they already hold a progression", () => {
    // I–IV–V–I, one chord per bar, twice. The windows across the held I
    // (IV–V–I–I, …) change only twice: kept, not rich, and too close to the
    // end to stretch.
    expect(phrases(section(progression([1, 4, 5, 1, 1, 4, 5, 1], 4)))).toEqual([
      [1, 4, true],
      [5, 4, false],
      [9, 4, false],
      [13, 4, false],
      [17, 4, true],
    ]);
  });

  it("stretches a back-and-forth to 8 bars when the song is fast", () => {
    // I–V–I–V then vi–IV–I–V, at 120 bpm: 8 bars last 16 s.
    expect(
      phrases(section(progression([1, 5, 1, 5, 6, 4, 1, 5], 4))).slice(0, 1),
    ).toEqual([[1, 8, true]]);
  });

  it("keeps the 4 bars of a slow song, ranked below the rich ones", () => {
    // The same harmony at 60 bpm: 8 bars would loop for 32 s.
    expect(
      phrases(
        section(progression([1, 5, 1, 5, 6, 4, 1, 5], 4), { tempos: [slow] }),
      ).slice(0, 1),
    ).toEqual([[1, 4, false]]);
  });

  it("never stretches to the same 4 bars played twice", () => {
    // I–IV–V–V twice: the 8 bars are rich, but hold nothing the 4 do not.
    expect(
      phrases(section(progression([1, 4, 5, 5, 1, 4, 5, 5], 4))).slice(0, 1),
    ).toEqual([[1, 4, false]]);
  });

  it("never stretches without a tempo to measure it by", () => {
    expect(
      phrases(
        section(progression([1, 5, 1, 5, 6, 4, 1, 5], 4), {
          tempos: [{ ...slow, bpm: null }],
        }),
      ).slice(0, 1),
    ).toEqual([[1, 4, false]]);
  });

  it("leaves out a vamp no length can rescue", () => {
    // Four bars of I, then I–V: the first window changes nothing.
    expect(
      phrases(section(progression([1, 1, 1, 1, 5], 4), { tempos: [slow] })),
    ).toEqual([[5, 4, false]]);
  });

  it("does not stretch past the chords one answer strip holds", () => {
    // Two chords a bar: 4 bars of I–V then 4 rich bars — 16 chords in 8 bars.
    expect(
      phrases(
        section(
          progression([1, 5, 1, 5, 1, 5, 1, 5, 6, 4, 2, 5, 6, 4, 2, 5], 2),
        ),
      ).slice(0, 1),
    ).toEqual([[1, 4, false]]);
  });
});
