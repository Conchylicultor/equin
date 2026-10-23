/**
 * The chord-grid cover's chords: holds and repeats collapse into one tile,
 * the cover stops at six, and each tile's degree reads against the grid's
 * `key:` directive (the one in force at the chord) or, with none, against
 * the first chord's root. The Chords cell names the first chords.
 *
 * Run: `./singularity test plugins/apps/plugins/sonata/plugins/sources/plugins/chord-grid`.
 */

import { describe, expect, test } from "bun:test";
import { coverChords, gridChordNames } from "./cover-chords";

const degrees = (text: string) => coverChords(text).map((c) => c.degree);
const numerals = (text: string) => coverChords(text).map((c) => c.numeral);

describe("coverChords", () => {
  test("an empty or unparseable grid has no tiles", () => {
    expect(coverChords("")).toEqual([]);
    expect(coverChords("; just a comment\nkey: G")).toEqual([]);
    expect(coverChords("Xyz")).toEqual([]);
  });

  test("holds and immediate repeats collapse into one tile", () => {
    expect(
      coverChords("C . . G (G Am) Am . F").map((c) => c.root + c.suffix),
    ).toEqual(["C", "G", "Am", "F"]);
  });

  test("a chord coming back later is a new tile", () => {
    expect(coverChords("C G C").length).toBe(3);
  });

  test("the cover holds at most six chords", () => {
    expect(coverChords("C D E F G A B C").length).toBe(6);
  });

  test("with no key directive, degrees read against the first chord's root", () => {
    // A as the tonic: A=I, F♯m=vi, D=IV, E=V.
    expect(degrees("A F#m D E")).toEqual([0, 5, 3, 4]);
    expect(numerals("A F#m D E")).toEqual(["I", "vi", "IV", "V"]);
  });

  test("a key directive sets the tonic, even when the grid opens elsewhere", () => {
    // In G: C=IV, D=V, G=I, Em=vi.
    expect(degrees("key: G C D G Em")).toEqual([3, 4, 0, 5]);
    // Read on the major scale in every key: in A minor, F is ♭VI.
    expect(numerals("key: Am Am F C G")).toEqual(["i", "♭VI", "♭III", "♭VII"]);
  });

  test("a modulation re-reads the chords after it", () => {
    // C in C is I; after `key: G`, D is V.
    expect(degrees("key: C C key: G D")).toEqual([0, 4]);
  });

  test("chords before the first directive read against it", () => {
    expect(degrees("C key: G D")).toEqual([3, 4]);
  });

  test("a symbol splits into its root and the rest", () => {
    expect(coverChords("Cmaj7 F#m7 Bb/D")).toMatchObject([
      { root: "C", suffix: "maj7" },
      { root: "F#", suffix: "m7" },
      { root: "Bb", suffix: "/D" },
    ]);
  });
});

describe("gridChordNames", () => {
  test("names the first chords, holds collapsed", () => {
    expect(gridChordNames("C . G Am F Dm", 4)).toEqual(["C", "G", "Am", "F"]);
  });
});
