import { describe, expect, it } from "bun:test";
import type { KeySignature } from "@plugins/apps/plugins/sonata/plugins/score/core";
import { CHORD_TEMPLATES } from "./chords";
import { parseRomanNumeral, romanNumeral, romanNumeralParts } from "./roman";

const C_MAJOR: KeySignature = { tonic: "C", mode: "major" };
const A_MINOR: KeySignature = { tonic: "A", mode: "minor" };

/** Build the {root, quality} shape `romanNumeral` reads. */
const chord = (root: number, quality: string) => ({ root, quality });

describe("romanNumeral — major-key diatonic triads", () => {
  // C major diatonic: I ii iii IV V vi vii°
  const cases: [number, string, string][] = [
    [0, "maj", "I"],
    [2, "min", "ii"],
    [4, "min", "iii"],
    [5, "maj", "IV"],
    [7, "maj", "V"],
    [9, "min", "vi"],
    [11, "dim", "vii°"],
  ];
  for (const [root, quality, expected] of cases) {
    it(`${expected} (root ${root}, ${quality})`, () => {
      expect(romanNumeral(chord(root, quality), C_MAJOR)).toBe(expected);
    });
  }
});

describe("romanNumeral — natural-minor triads read against the major scale", () => {
  // A minor diatonic: i ii° ♭III iv v ♭VI ♭VII — one numeral per chord over a
  // tonic, whatever the mode.
  const cases: [number, string, string][] = [
    [9, "min", "i"],
    [11, "dim", "ii°"],
    [0, "maj", "♭III"],
    [2, "min", "iv"],
    [4, "min", "v"],
    [5, "maj", "♭VI"],
    [7, "maj", "♭VII"],
  ];
  for (const [root, quality, expected] of cases) {
    it(`${expected} (root ${root}, ${quality})`, () => {
      expect(romanNumeral(chord(root, quality), A_MINOR)).toBe(expected);
    });
  }
});

describe("romanNumeral — sevenths carry the figure", () => {
  it("V7 (dominant seventh)", () => {
    expect(romanNumeral(chord(7, "dom7"), C_MAJOR)).toBe("V7");
  });
  it("Imaj7", () => {
    expect(romanNumeral(chord(0, "maj7"), C_MAJOR)).toBe("Imaj7");
  });
  it("ii7 (minor seventh)", () => {
    expect(romanNumeral(chord(2, "min7"), C_MAJOR)).toBe("ii7");
  });
  it("viiø7 (half-diminished)", () => {
    expect(romanNumeral(chord(11, "halfdim7"), C_MAJOR)).toBe("viiø7");
  });
  it("vii°7 (fully diminished, minor key leading tone)", () => {
    expect(romanNumeral(chord(8, "dim7"), A_MINOR)).toBe("vii°7");
  });
});

describe("romanNumeral — chromatic / borrowed chords", () => {
  it("♭VII in C major (B♭ major)", () => {
    expect(romanNumeral(chord(10, "maj"), C_MAJOR)).toBe("♭VII");
  });
  it("♭III in C major (E♭ major)", () => {
    expect(romanNumeral(chord(3, "maj"), C_MAJOR)).toBe("♭III");
  });
  it("♭VI in C major (A♭ major)", () => {
    expect(romanNumeral(chord(8, "maj"), C_MAJOR)).toBe("♭VI");
  });
  it("♯IV° (raised-fourth diminished) in C major", () => {
    expect(romanNumeral(chord(6, "dim"), C_MAJOR)).toBe("♯iv°");
  });
  it("♭II (Neapolitan) in A minor", () => {
    expect(romanNumeral(chord(10, "maj"), A_MINOR)).toBe("♭II");
  });
});

describe("romanNumeral — function is key-relative", () => {
  it("same C-major chord reads I / IV / ♭VI across keys", () => {
    expect(romanNumeral(chord(0, "maj"), C_MAJOR)).toBe("I");
    expect(romanNumeral(chord(0, "maj"), { tonic: "G", mode: "major" })).toBe(
      "IV",
    );
    expect(romanNumeral(chord(0, "maj"), { tonic: "E", mode: "minor" })).toBe(
      "♭VI",
    );
  });
  it("respects an accidental tonic (V in F♯ major)", () => {
    // F# = pc 6; its dominant is C# = pc 1.
    expect(romanNumeral(chord(1, "maj"), { tonic: "F#", mode: "major" })).toBe(
      "V",
    );
  });
});

describe("romanNumeral — augmented / extended", () => {
  it("III+ (augmented triad)", () => {
    expect(romanNumeral(chord(4, "aug"), C_MAJOR)).toBe("III+");
  });
  it("V9", () => {
    expect(romanNumeral(chord(7, "dom9"), C_MAJOR)).toBe("V9");
  });
  it("IVsus4", () => {
    expect(romanNumeral(chord(5, "sus4"), C_MAJOR)).toBe("IVsus4");
  });
});

// ---------------------------------------------------------------------------
// parseRomanNumeral — the inverse
// ---------------------------------------------------------------------------

describe("parseRomanNumeral — major-key diatonic triads", () => {
  // C major diatonic: I ii iii IV V vi vii°
  const cases: [string, number, string][] = [
    ["I", 0, "maj"],
    ["ii", 2, "min"],
    ["iii", 4, "min"],
    ["IV", 5, "maj"],
    ["V", 7, "maj"],
    ["vi", 9, "min"],
    ["vii°", 11, "dim"],
  ];
  for (const [numeral, root, quality] of cases) {
    it(`${numeral} → root ${root}, ${quality}`, () => {
      expect(parseRomanNumeral(numeral, C_MAJOR)).toMatchObject({
        root,
        quality,
      });
    });
  }
});

describe("parseRomanNumeral — degrees are read on the major scale", () => {
  it("♭VI in A minor is F, and VI is F♯", () => {
    expect(parseRomanNumeral("♭VI", A_MINOR)).toMatchObject({ root: 5 });
    expect(parseRomanNumeral("VI", A_MINOR)).toMatchObject({ root: 6 });
  });
  it("vi in C major is A minor", () => {
    expect(parseRomanNumeral("vi", C_MAJOR)!.symbol).toBe("Am");
  });
  it("V7 in F major is C7", () => {
    expect(parseRomanNumeral("V7", { tonic: "F", mode: "major" })!.symbol).toBe(
      "C7",
    );
  });
  it("accepts an accidental tonic (V in F♯ major is C♯)", () => {
    expect(
      parseRomanNumeral("V", { tonic: "F#", mode: "major" }),
    ).toMatchObject({
      root: 1,
    });
  });
});

describe("parseRomanNumeral — the quality lives in case + mark + figure", () => {
  const cases: [string, string][] = [
    ["Imaj7", "maj7"],
    ["I7", "dom7"],
    ["ii7", "min7"],
    ["iiø7", "halfdim7"],
    ["vii°7", "dim7"],
    ["III+", "aug"],
    ["V9", "dom9"],
    ["IVsus4", "sus4"],
    ["I6/9", "six9"],
    ["imaj7", "minmaj7"],
  ];
  for (const [numeral, quality] of cases) {
    it(`${numeral} → ${quality}`, () => {
      expect(parseRomanNumeral(numeral, C_MAJOR)!.quality).toBe(quality);
    });
  }

  it("accepts ASCII stand-ins for the glyphs", () => {
    expect(parseRomanNumeral("viio7", C_MAJOR)!.quality).toBe("dim7");
    expect(parseRomanNumeral("viidim7", C_MAJOR)!.quality).toBe("dim7");
    expect(parseRomanNumeral("IM7", C_MAJOR)!.quality).toBe("maj7");
    expect(parseRomanNumeral("bVII", C_MAJOR)!.root).toBe(10);
    expect(parseRomanNumeral("#IV", C_MAJOR)!.root).toBe(6);
  });
});

describe("parseRomanNumeral — chromatic degrees", () => {
  it("♭VII in C major is B♭ major", () => {
    expect(parseRomanNumeral("♭VII", C_MAJOR)).toMatchObject({
      root: 10,
      quality: "maj",
    });
  });
  it("♯iv° in C major is F♯ diminished", () => {
    expect(parseRomanNumeral("♯iv°", C_MAJOR)).toMatchObject({
      root: 6,
      quality: "dim",
    });
  });
  it("♭II (Neapolitan) in A minor is B♭ major", () => {
    expect(parseRomanNumeral("♭II", A_MINOR)).toMatchObject({ root: 10 });
  });
});

describe("parseRomanNumeral — spells the root through the key", () => {
  it("♭VII in F major reads E♭, not D♯", () => {
    const chord = parseRomanNumeral("♭VII", { tonic: "F", mode: "major" })!;
    expect(chord.symbol).toBe("D#"); // normalized sharps
    expect(chord.spelledSymbol).toBe("E♭"); // key-aware refinement
  });
  it("omits spelledSymbol when it matches the normalized symbol", () => {
    expect(parseRomanNumeral("V", C_MAJOR)!.spelledSymbol).toBeUndefined();
  });
});

describe("parseRomanNumeral — rejects non-numerals", () => {
  for (const bad of ["", "C", "Am7", "Iv", "IIII", "VV", "ii?", "vsus4", "#"]) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      expect(parseRomanNumeral(bad, C_MAJOR)).toBeNull();
    });
  }
});

describe("parseRomanNumeral — spelled-out marks are case-insensitive", () => {
  // An explicit mark (°/ø/+, or spelled dim/aug) fixes the third, so the numeral
  // reads the same with an upper- or lowercase glyph. The lowercase forms are the
  // convention; the uppercase forms are how lead sheets often write them.
  const cases: [string, string][] = [
    ["Iaug", "aug"],
    ["iaug", "aug"],
    ["III+", "aug"],
    ["Idim7", "dim7"],
    ["IIdim7", "dim7"],
    ["viidim7", "dim7"],
    ["Idim", "dim"],
    ["Iø7", "halfdim7"],
    ["IIø7", "halfdim7"],
    ["I+7", "aug7"],
    ["Iaug7", "aug7"],
    ["I+maj7", "augmaj7"],
    ["Iaugmaj7", "augmaj7"],
  ];
  for (const [numeral, quality] of cases) {
    it(`${numeral} → ${quality}`, () => {
      expect(parseRomanNumeral(numeral, C_MAJOR)!.quality).toBe(quality);
    });
  }
});

describe("parseRomanNumeral — altered / extended tensions", () => {
  it("V7♭9 in C major is an altered G dominant (b9)", () => {
    const chord = parseRomanNumeral("V7b9", C_MAJOR)!;
    expect(chord.root).toBe(7); // G
    expect(chord.quality).toBe("dom7");
    expect(chord.intervals).toEqual([4, 7, 10, 13]); // 3, 5, ♭7, ♭9
    expect(chord.symbol).toBe("G7(♭9)");
  });

  it("accepts the ♯9 / ♯5 / ♭5 altered-dominant family", () => {
    expect(parseRomanNumeral("V7#9", C_MAJOR)!.intervals).toEqual([
      4, 7, 10, 15,
    ]);
    expect(parseRomanNumeral("V7#5", C_MAJOR)!.intervals).toEqual([4, 8, 10]);
    expect(parseRomanNumeral("V7b5", C_MAJOR)!.intervals).toEqual([4, 6, 10]);
  });

  it("glyph and parenthesised spellings parse identically", () => {
    const bare = parseRomanNumeral("V7b9", C_MAJOR)!;
    expect(parseRomanNumeral("V7♭9", C_MAJOR)).toMatchObject({
      intervals: bare.intervals,
    });
    expect(parseRomanNumeral("V7(♭9)", C_MAJOR)).toMatchObject({
      intervals: bare.intervals,
    });
  });

  it("lowercase minor takes alterations too (i7♭5 = min7♭5)", () => {
    expect(parseRomanNumeral("i7b5", C_MAJOR)!.intervals).toEqual([3, 6, 10]);
  });

  it("applies suspensions and added tones on a numeral", () => {
    expect(parseRomanNumeral("I7sus4", C_MAJOR)!.intervals).toEqual([5, 7, 10]);
    expect(parseRomanNumeral("Iadd9", C_MAJOR)!.intervals).toEqual([4, 7, 14]);
  });

  it("still rejects a bare figure that names no quality for the case", () => {
    expect(parseRomanNumeral("vsus4", C_MAJOR)).toBeNull();
    expect(parseRomanNumeral("v13", C_MAJOR)).toBeNull();
  });

  it("still rejects unrecognised trailing text as a typo", () => {
    expect(parseRomanNumeral("V7zz", C_MAJOR)).toBeNull();
    expect(parseRomanNumeral("Idim7x", C_MAJOR)).toBeNull();
  });
});

describe("romanNumeral ⇄ parseRomanNumeral round-trip", () => {
  const QUALITIES = CHORD_TEMPLATES.map((t) => t.quality);
  for (const key of [
    C_MAJOR,
    A_MINOR,
    { tonic: "Eb", mode: "major" } as const,
  ]) {
    for (const quality of QUALITIES) {
      it(`every root, ${quality} in ${key.tonic} ${key.mode}`, () => {
        for (let root = 0; root < 12; root++) {
          const numeral = romanNumeral(chord(root, quality), key);
          expect(numeral).not.toBeNull();
          expect(parseRomanNumeral(numeral!, key)).toMatchObject({
            root,
            quality,
          });
        }
      });
    }
  }
});

describe("romanNumeralParts", () => {
  it("splits the numeral from its mark and figure", () => {
    expect(romanNumeralParts(chord(11, "halfdim7"), C_MAJOR)).toEqual({
      numeral: "vii",
      mark: "ø7",
    });
    expect(romanNumeralParts(chord(10, "maj"), C_MAJOR)).toEqual({
      numeral: "♭VII",
      mark: "",
    });
  });

  it("joins back into romanNumeral", () => {
    for (const { quality } of CHORD_TEMPLATES) {
      const parts = romanNumeralParts(chord(7, quality), C_MAJOR);
      expect(parts === null ? null : parts.numeral + parts.mark).toBe(
        romanNumeral(chord(7, quality), C_MAJOR),
      );
    }
  });

  it("is null outside the vocabulary", () => {
    expect(romanNumeralParts(chord(0, "nope"), C_MAJOR)).toBeNull();
  });
});
