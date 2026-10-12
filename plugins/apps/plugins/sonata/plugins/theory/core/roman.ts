/**
 * Functional harmony, both directions: a chord + the key it sits in ↔ its
 * Roman-numeral label (I, ii, V7, ♭VII, vii°7, …).
 *
 * This is the third face of the two-layer chord model, alongside `formatChord-
 * Symbol` (chord → letter name) and `detectChord` (notes → chord): given the key
 * *context* it names a chord by its scale-degree *function* rather than its
 * absolute root. So the same Cmaj chord reads "I" in C major but "IV" in G major
 * and "♭VI" in E minor.
 *
 * `romanNumeral` reads a chord as a numeral; `parseRomanNumeral` is its exact
 * inverse, resolving an authored numeral back to a concrete chord in the key —
 * so a chord-authoring source (the chord grid) can accept `I vi IV V` wherever
 * it accepts `C Am F G`. Both share one degree model and one quality table, and
 * the table is checked for injectivity at module eval, so the round-trip cannot
 * silently rot.
 *
 * The numeral is derived purely from the chord root's semitone interval above
 * the tonic, read against the MAJOR scale in every key with the conventional
 * chromatic readings (`music/chord-box`'s `rootReading`, which the chord box's
 * colour reads too) — NOT from the key speller, so a lowered-sixth chord reads
 * "♭VI" rather than the speller's enharmonic "♯V". A minor key is no exception:
 * B minor reads i ii° ♭III iv v ♭VI ♭VII, so a chord over a tonic has one
 * numeral whatever the song's mode. The chord *quality* then only
 * decides the numeral's case (upper = major family, lower = minor/diminished), a
 * quality mark (° dim, ø half-dim, + aug), and a seventh/extension figure.
 *
 * Inversions are intentionally NOT figured here — the root-position function is
 * what the label conveys; the slash bass already shows in the chord symbol.
 *
 * Pure TypeScript: no React, no framework. Imports only `score/core` and sibling
 * theory modules, keeping the DAG acyclic.
 */

import {
  MAJOR_SCALE,
  rootReading,
} from "@plugins/music/plugins/chord-box/core";
import {
  makeKeySpeller,
  type ChordData,
  type KeySignature,
} from "@plugins/apps/plugins/sonata/plugins/score/core";
import { applyModifierTail } from "./chord-body";
import { formatChordSymbol, formatSpelledChordSymbol } from "./chords";
import { tonicPc } from "./key-detect";

/** Roman-numeral glyph per 1-based diatonic degree. */
const NUMERALS = ["I", "II", "III", "IV", "V", "VI", "VII"] as const;

/** Reduce any integer to a pitch-class in [0, 12). */
const pc12 = (pc: number): number => ((pc % 12) + 12) % 12;

/** How a chord quality cases and decorates its numeral. */
interface RomanStyle {
  /** Minor/diminished families are lowercase; major/augmented uppercase. */
  lower: boolean;
  /** Triad-quality mark: "°" diminished, "ø" half-diminished, "+" augmented. */
  mark?: string;
  /** Seventh / extension figure appended after the numeral (e.g. "7", "maj7"). */
  figure?: string;
}

/**
 * Per-quality styling, keyed by the canonical `ChordData.quality`. Mirrors the
 * chord vocabulary in `chords.ts` (every `CHORD_TEMPLATES` quality is covered),
 * but expressed as case + mark + figure so the numeral carries the same harmonic
 * information the chord suffix does.
 */
const STYLE: Record<string, RomanStyle> = {
  // Triads
  maj: { lower: false },
  min: { lower: true },
  aug: { lower: false, mark: "+" },
  dim: { lower: true, mark: "°" },
  // Sevenths
  maj7: { lower: false, figure: "maj7" },
  dom7: { lower: false, figure: "7" },
  min7: { lower: true, figure: "7" },
  minmaj7: { lower: true, figure: "maj7" },
  halfdim7: { lower: true, mark: "ø", figure: "7" },
  dim7: { lower: true, mark: "°", figure: "7" },
  augmaj7: { lower: false, mark: "+", figure: "maj7" },
  aug7: { lower: false, mark: "+", figure: "7" },
  // Sixths / added-tone / extended / suspended
  maj6: { lower: false, figure: "6" },
  min6: { lower: true, figure: "6" },
  maj9: { lower: false, figure: "maj9" },
  dom9: { lower: false, figure: "9" },
  min9: { lower: true, figure: "9" },
  dom13: { lower: false, figure: "13" },
  sus2: { lower: false, figure: "sus2" },
  sus4: { lower: false, figure: "sus4" },
  six9: { lower: false, figure: "6/9" },
};

/**
 * The Roman-numeral label for `chord` in `key` split in two, as a numeral is
 * typeset: `numeral` (the accidental and the cased degree — `I`, `ii`, `♭VII`)
 * and `mark` (the quality mark and figure set small beside it — `°`, `ø7`,
 * `maj7`; `""` for a plain triad). `null` when the quality is outside the
 * vocabulary. {@link romanNumeral} is the two joined.
 */
export function romanNumeralParts(
  chord: Pick<ChordData, "root" | "quality">,
  key: KeySignature,
): { numeral: string; mark: string } | null {
  const style = STYLE[chord.quality];
  if (!style) return null;

  const { degree, accidental: acc } = rootReading(
    chord.root,
    tonicPc(key.tonic),
  );
  const base = NUMERALS[degree]!;
  const numeral = style.lower ? base.toLowerCase() : base;
  const accidental = acc === 0 ? "" : acc < 0 ? "♭" : "♯";

  return {
    numeral: accidental + numeral,
    mark: (style.mark ?? "") + (style.figure ?? ""),
  };
}

/**
 * The Roman-numeral label for `chord` in `key`, e.g. `{root:7,quality:"dom7"}`
 * in C major → `"V7"`, `{root:9,quality:"min"}` in C major → `"vi"`, a B♭ major
 * chord in C major → `"♭VII"`. Returns `null` when the quality is outside the
 * vocabulary (so a caller simply omits the numeral rather than crashing).
 */
export function romanNumeral(
  chord: Pick<ChordData, "root" | "quality">,
  key: KeySignature,
): string | null {
  const parts = romanNumeralParts(chord, key);
  return parts === null ? null : parts.numeral + parts.mark;
}

// ---------------------------------------------------------------------------
// The inverse: numeral + key → chord
// ---------------------------------------------------------------------------

/** Numeral glyph → 1-based diatonic degree (the inverse of `NUMERALS`). */
const DEGREE_BY_NUMERAL = new Map<string, number>(
  NUMERALS.map((glyph, i) => [glyph, i + 1]),
);

/**
 * `STYLE` inverted, split by whether the quality carries an explicit triad mark:
 *
 * - **Unmarked** qualities (`maj`/`min`/`dom7`/`min7`/…) are told apart *only* by
 *   the numeral's case, so they invert on `case|figure` — the case is
 *   load-bearing (`V7` = dom7 vs `v7` = min7) and must match exactly.
 * - **Marked** qualities (`°` dim, `ø` half-dim, `+` aug) are told apart by the
 *   mark itself, which fixes the third regardless of case — so they invert on
 *   `mark|figure` and the numeral's case is *not* consulted. This is why both
 *   `vii°7` and the equally common uppercase `VII°7` / `VIIdim7` resolve to the
 *   same diminished chord.
 *
 * Both maps are built at module eval and **throw on a collision**, so a
 * non-injective `romanNumeral` (which no parser could undo) stays impossible.
 */
const UNMARKED_QUALITY = new Map<string, string>();
const MARKED_QUALITY = new Map<string, string>();
for (const [quality, style] of Object.entries(STYLE)) {
  const figure = style.figure ?? "";
  const [map, key] = style.mark
    ? [MARKED_QUALITY, `${style.mark}|${figure}`]
    : [UNMARKED_QUALITY, `${style.lower ? "l" : "u"}|${figure}`];
  const clash = map.get(key);
  if (clash) {
    throw new Error(
      `[theory] Roman-numeral style collision: "${quality}" and "${clash}" both render as ${key}`,
    );
  }
  map.set(key, quality);
}

/**
 * Accepted spellings of a triad-quality mark, longest-first so `dim`/`aug` are
 * read whole rather than as a stray glyph. `°`/`o`/`dim` are the diminished
 * spellings, `ø` half-diminished, `+`/`aug` augmented.
 */
const MARK_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ["dim", "°"],
  ["aug", "+"],
  ["°", "°"],
  ["o", "°"],
  ["ø", "ø"],
  ["+", "+"],
];

/**
 * Accepted spellings of a base seventh/extension figure, each paired with the
 * canonical figure `STYLE` uses. Matched longest-first so `maj7` wins over the
 * empty figure and `6/9` over `6`. The empty figure `""` is the always-matching
 * fallback (a bare triad), whose case + mark then decide the quality.
 */
const FIGURE_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ["6/9", "6/9"],
  ["maj9", "maj9"],
  ["maj7", "maj7"],
  ["sus2", "sus2"],
  ["sus4", "sus4"],
  ["M9", "maj9"],
  ["M7", "maj7"],
  ["13", "13"],
  ["7", "7"],
  ["6", "6"],
  ["9", "9"],
  ["", ""],
];

/**
 * A numeral: an optional chromatic accidental, then I–VII in a *uniform* case
 * (upper = major family, lower = minor/diminished), then the mark + figure tail.
 */
const ROMAN = /^([♭♯b#]?)([IViv]+)(.*)$/;

/** A numeral head resolved to its base quality plus the modifier tail after it. */
interface ResolvedHead {
  quality: string;
  /** Everything after the base figure — the modifier tail (`b9`, `sus4`, …). */
  rest: string;
}

/**
 * Split a numeral tail into its base quality (case + mark + figure) and the
 * modifier tail that follows, or `null` when no known quality heads it.
 *
 * `lower` is the numeral's case (consulted only for *unmarked* qualities). The
 * tail reads as `[mark][figure][modifiers]`: an optional triad mark, then the
 * longest known base figure — their combination resolving a quality — and
 * whatever remains is the modifier tail handed to the shared grammar.
 */
function resolveHead(lower: boolean, tail: string): ResolvedHead | null {
  const markAlias = MARK_ALIASES.find(([spelling]) =>
    tail.startsWith(spelling),
  );
  const mark = markAlias ? markAlias[1] : "";
  const afterMark = markAlias ? tail.slice(markAlias[0].length) : tail;

  // The "" figure always matches, so `find` never fails.
  const figAlias = FIGURE_ALIASES.find(([spelling]) =>
    afterMark.startsWith(spelling),
  )!;
  const figure = figAlias[1];

  const quality = mark
    ? MARKED_QUALITY.get(`${mark}|${figure}`)
    : UNMARKED_QUALITY.get(`${lower ? "l" : "u"}|${figure}`);
  if (quality === undefined) return null;

  return { quality, rest: afterMark.slice(figAlias[0].length) };
}

/**
 * Resolve an authored Roman numeral to the concrete chord it names in `key` —
 * the inverse of `romanNumeral`, plus the alteration tail. `"vi"` in C major → A
 * minor, `"V7"` in F major → C7, `"♭VII"` in C major → B♭ major, `"iiø7"` → a
 * half-diminished ii, `"V7♭9"` → an altered dominant.
 *
 * The root is the numeral's degree on the MAJOR scale above the tonic, in a
 * minor key too (so `♭VI` in A minor is F, and `VI` is F♯), shifted by the
 * leading accidental; the base quality is whatever `romanNumeral` would have rendered as
 * this case + mark + figure, and any trailing alterations (`♭9`, `♯5`, `sus4`,
 * `add9`, …) are realised by the same modifier grammar letter-name chords use,
 * so the numeral side and the letter side accept the same chord vocabulary.
 *
 * ASCII stand-ins are accepted for the glyphs (`b`/`#` for `♭`/`♯`, `o`/`dim`
 * for `°`, `aug` for `+`, `M7` for `maj7`). An explicit mark (`°`/`ø`/`+` and
 * their spellings) fixes the quality's third, so `Idim7` and `IIø7` are accepted
 * with an uppercase numeral just as `i°7` / `iiø7` are with a lowercase one.
 *
 * The chord is spelled through the key (`spelledSymbol`) as well as normalized
 * to sharps (`symbol`), so `♭VII` in F major reads "E♭" rather than "D♯".
 *
 * Returns `null` for anything that is not a Roman numeral in this vocabulary, so
 * callers can fall through to the letter-name parser (`parseChordSymbol`) or
 * surface the token as a typo — never crash on user input.
 */
export function parseRomanNumeral(
  input: string,
  key: KeySignature,
): ChordData | null {
  const m = ROMAN.exec(input.trim());
  if (!m) return null;

  // A numeral is written in ONE case — its case IS the quality. `Iv` is a typo.
  const numeral = m[2]!;
  const lower = numeral === numeral.toLowerCase();
  const upper = numeral === numeral.toUpperCase();
  if (lower === upper) return null;

  const n = DEGREE_BY_NUMERAL.get(numeral.toUpperCase());
  if (n === undefined) return null; // e.g. "IIII", "VV"

  const head = resolveHead(lower, m[3]!);
  if (head === null) return null;

  // The tail after the base figure is an alteration/extension tail (`♭9`, `sus4`,
  // `add9`, …) — realised by the same grammar letter-name chords use.
  const tail = applyModifierTail(head.quality, head.rest);
  if (tail === null) return null;

  const accText = m[1]!;
  const acc = accText === "" ? 0 : accText === "♯" || accText === "#" ? 1 : -1;
  const root = pc12(tonicPc(key.tonic) + MAJOR_SCALE[n - 1]! + acc);

  const { quality } = head;
  const symbol = formatChordSymbol({ root, quality }) + tail.modSuffix;
  const spelledSymbol =
    formatSpelledChordSymbol({ root, quality }, makeKeySpeller(key)) +
    tail.modSuffix;
  const data: ChordData = { root, quality, symbol };
  if (tail.intervals) data.intervals = tail.intervals;
  if (spelledSymbol !== symbol) data.spelledSymbol = spelledSymbol;
  return data;
}
