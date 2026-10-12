import { describe, expect, it } from "bun:test";
import type { KeySignature } from "@plugins/apps/plugins/sonata/plugins/score/core";
import { diatonicChords } from "./diatonic";
import { parseRomanNumeral } from "./roman";

const C_MAJOR: KeySignature = { tonic: "C", mode: "major" };
const A_MINOR: KeySignature = { tonic: "A", mode: "minor" };
const B_MAJOR: KeySignature = { tonic: "B", mode: "major" };
const F_MAJOR: KeySignature = { tonic: "F", mode: "major" };

/** The displayed symbol: the key spelling when it differs, else the normalized one. */
const shown = (key: KeySignature, sevenths = false) =>
  diatonicChords(key, { sevenths }).map(
    (d) => d.chord.spelledSymbol ?? d.chord.symbol,
  );

describe("diatonicChords", () => {
  it("C major triads", () => {
    const chords = diatonicChords(C_MAJOR);
    expect(chords.map((d) => d.degree)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(chords.map((d) => d.chord.symbol)).toEqual([
      "C",
      "Dm",
      "Em",
      "F",
      "G",
      "Am",
      "Bdim",
    ]);
    expect(chords.map((d) => d.numeral)).toEqual([
      "I",
      "ii",
      "iii",
      "IV",
      "V",
      "vi",
      "vii°",
    ]);
    // Natural spellings need no refinement.
    expect(chords.every((d) => d.chord.spelledSymbol === undefined)).toBe(true);
  });

  it("C major sevenths", () => {
    const chords = diatonicChords(C_MAJOR, { sevenths: true });
    expect(chords.map((d) => d.chord.symbol)).toEqual([
      "Cmaj7",
      "Dm7",
      "Em7",
      "Fmaj7",
      "G7",
      "Am7",
      "Bø7",
    ]);
    expect(chords.map((d) => d.numeral)).toEqual([
      "Imaj7",
      "ii7",
      "iii7",
      "IVmaj7",
      "V7",
      "vi7",
      "viiø7",
    ]);
  });

  it("A minor triads use natural minor", () => {
    const chords = diatonicChords(A_MINOR);
    expect(chords.map((d) => d.chord.symbol)).toEqual([
      "Am",
      "Bdim",
      "C",
      "Dm",
      "Em",
      "F",
      "G",
    ]);
    expect(chords.map((d) => d.numeral)).toEqual([
      "i",
      "ii°",
      "♭III",
      "iv",
      "v",
      "♭VI",
      "♭VII",
    ]);
  });

  it("B major spells sharps through the key", () => {
    expect(shown(B_MAJOR)).toEqual([
      "B",
      "C♯m",
      "D♯m",
      "E",
      "F♯",
      "G♯m",
      "A♯dim",
    ]);
  });

  it("F major spells B♭", () => {
    const iv = diatonicChords(F_MAJOR)[3]!.chord;
    expect(iv.symbol).toBe("A#");
    expect(iv.spelledSymbol).toBe("B♭");
  });

  it("round-trips through parseRomanNumeral", () => {
    for (const key of [C_MAJOR, A_MINOR, B_MAJOR, F_MAJOR]) {
      for (const sevenths of [false, true]) {
        for (const d of diatonicChords(key, { sevenths })) {
          const parsed = parseRomanNumeral(d.numeral, key);
          expect(parsed?.root).toBe(d.chord.root);
          expect(parsed?.quality).toBe(d.chord.quality);
        }
      }
    }
  });
});
