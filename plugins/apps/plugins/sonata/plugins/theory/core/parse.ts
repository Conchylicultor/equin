/**
 * Forward chord parsing: a chord symbol string → `ChordData`.
 *
 * This is the inverse of the chord-analyzer's `detectChord` (notes → chord).
 * Chord-authoring sources (e.g. the chord grid, Ultimate-Guitar tabs) parse
 * user-typed symbols like `"Cmaj7"`, `"F#m"`, `"Bbdim7"`, `"G7(♯5)"`,
 * `"Gsus4(♭9)"`, `"Eb6/9"` into `{ root, quality, symbol }`, then realise them
 * into notes via a voicing strategy.
 *
 * Rather than an exact-match table of every chord (which cannot scale to stacked
 * alterations), the parser is a small **grammar**:
 *
 *     root  →  optional /bass  →  base head  →  modifier tail
 *
 * The base head (`maj7`, `m7`, `7`, `sus4`, `6/9`, …) seeds a **degree→semitone
 * map**; each trailing modifier (`(♯5)`, `(♭9)`, `add9`, `no3`, a bare `sus4` on a
 * 7th, …) mutates that map by scale degree, so replacement (e.g. `♯5` overriding
 * the natural 5) is unambiguous and any combination composes for free. The sorted
 * map values become `ChordData.intervals` — the authoritative realised interval
 * set — but only when the chord is altered beyond its base `quality`; a plain
 * quality leaves `intervals` absent and derives its pitches from `quality`.
 *
 * Returns `null` for anything that isn't a recognised chord, so callers can skip
 * (and surface) typos rather than crash on user input.
 *
 * Slash/inversion symbols (`"C/E"`, `"D/F#"`, `"Am7/G"`) ARE parsed: the symbol
 * is split on its LAST `/` and the tail is treated as a bass **only if it parses
 * as a bare note** — so `"Eb6/9"` (tail `9`, not a note) stays a 6/9 chord rather
 * than being mis-read as a slash bass, while `"C6/E"` (tail `E`) is an inversion.
 * The chord part still has to be a recognised chord and the bass a recognised
 * note, else the whole symbol is unrecognised (`null`).
 */

import type { ChordData } from "@plugins/apps/plugins/sonata/plugins/score/core";
import { applyModifierTail } from "./chord-body";
import { qualitySymbol } from "./chords";

/** Note letter → natural pitch-class. */
const LETTER_PC: Record<string, number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

/**
 * Read a bare note (letter A–G + accidentals) into its pitch class, or `null`.
 * Shared by the root parse and the slash-bass parse so the accidental math has
 * one home.
 */
function parseNotePc(s: string): number | null {
  const m = /^([A-Ga-g])([#b♯♭]*)$/.exec(s);
  if (!m) return null;

  let pc = LETTER_PC[m[1]!.toUpperCase()]!;
  for (const ch of m[2]!) {
    if (ch === "#" || ch === "♯") pc += 1;
    else if (ch === "b" || ch === "♭") pc -= 1;
  }
  return ((pc % 12) + 12) % 12;
}

// ---------------------------------------------------------------------------
// Base heads
// ---------------------------------------------------------------------------

/**
 * A recognised base-quality prefix (`suffix`) and the canonical `quality` it
 * seeds. Matched **longest-first** against the body (a prefix, not the whole
 * remainder), so `"maj7"` wins over `"m"`, `"6/9"` over `"6"`, and the empty
 * `""` head (major triad) is the always-matching fallback whose modifier tail
 * then decides recognised-vs-typo. Includes the historical aliases so existing
 * spellings (`"major7"`, `"-7"`, `"ø"`, …) still normalise.
 */
const HEADS: ReadonlyArray<{ suffix: string; quality: string }> = [
  // ── extended (longest aliases first) ─────────────────────────────────────
  { suffix: "6/9", quality: "six9" },
  { suffix: "major9", quality: "maj9" },
  { suffix: "maj9", quality: "maj9" },
  { suffix: "M9", quality: "maj9" },
  { suffix: "min9", quality: "min9" },
  { suffix: "m9", quality: "min9" },
  { suffix: "-9", quality: "min9" },
  { suffix: "9", quality: "dom9" },
  { suffix: "13", quality: "dom13" },
  { suffix: "min6", quality: "min6" },
  { suffix: "m6", quality: "min6" },
  { suffix: "-6", quality: "min6" },
  { suffix: "6", quality: "maj6" },
  // ── suspended ────────────────────────────────────────────────────────────
  { suffix: "sus2", quality: "sus2" },
  { suffix: "sus4", quality: "sus4" },
  { suffix: "sus", quality: "sus4" },
  // ── 7th chords ───────────────────────────────────────────────────────────
  { suffix: "maj7", quality: "maj7" },
  { suffix: "major7", quality: "maj7" },
  { suffix: "M7", quality: "maj7" },
  { suffix: "minmaj7", quality: "minmaj7" },
  { suffix: "mmaj7", quality: "minmaj7" },
  { suffix: "m(maj7)", quality: "minmaj7" },
  { suffix: "mM7", quality: "minmaj7" },
  { suffix: "min7", quality: "min7" },
  { suffix: "m7b5", quality: "halfdim7" },
  { suffix: "m7", quality: "min7" },
  { suffix: "-7", quality: "min7" },
  { suffix: "dom7", quality: "dom7" },
  { suffix: "7", quality: "dom7" },
  { suffix: "ø7", quality: "halfdim7" },
  { suffix: "ø", quality: "halfdim7" },
  { suffix: "dim7", quality: "dim7" },
  { suffix: "o7", quality: "dim7" },
  { suffix: "°7", quality: "dim7" },
  { suffix: "+M7", quality: "augmaj7" },
  { suffix: "augmaj7", quality: "augmaj7" },
  { suffix: "+7", quality: "aug7" },
  { suffix: "aug7", quality: "aug7" },
  // ── triads ─────────────────────────────────────────────────────────────--
  { suffix: "dim", quality: "dim" },
  { suffix: "°", quality: "dim" },
  { suffix: "o", quality: "dim" },
  { suffix: "aug", quality: "aug" },
  { suffix: "+", quality: "aug" },
  { suffix: "min", quality: "min" },
  { suffix: "m", quality: "min" },
  { suffix: "-", quality: "min" },
  { suffix: "maj", quality: "maj" },
  { suffix: "major", quality: "maj" },
  { suffix: "", quality: "maj" },
];

/**
 * Quality words that read the same in any case: `Maj7`, `MAJ7`, `Min7`, `Dim`,
 * `Sus4` are all common spellings of the same head. Only these multi-letter
 * words fold case — the single letters `m` (minor) and `M` (major) mean
 * different things, so they stay exact (`CM7` ≠ `Cm7`, `mMaj7` ≠ `MMaj7`).
 * Longest first, so `major` is read as one word rather than `maj` + `or`.
 */
const CASELESS_WORDS = ["major", "maj", "min", "dim", "aug", "sus", "dom"];

/**
 * A head suffix as a prefix matcher: its caseless words match in any case,
 * every other character exactly.
 */
function headMatcher(suffix: string): RegExp {
  let source = "";
  let i = 0;
  while (i < suffix.length) {
    const word = CASELESS_WORDS.find((w) => suffix.startsWith(w, i));
    if (word) {
      for (const ch of word) source += `[${ch}${ch.toUpperCase()}]`;
      i += word.length;
    } else {
      source += suffix[i]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`^${source}`);
}

const HEADS_BY_LENGTH = [...HEADS]
  .sort((a, b) => b.suffix.length - a.suffix.length)
  .map((h) => ({ ...h, matcher: headMatcher(h.suffix) }));

// ---------------------------------------------------------------------------
// Body & symbol parsing
// ---------------------------------------------------------------------------

interface ParsedBody {
  quality: string;
  /** Realised interval set, or `null` when the chord is a plain head (no mods). */
  intervals: number[] | null;
  /** Canonical suffix (head suffix + rendered modifiers). */
  suffix: string;
}

/** Parse the body (everything after the root, no slash bass) or `null`. */
function parseBody(body: string): ParsedBody | null {
  const head = HEADS_BY_LENGTH.find((h) => h.matcher.test(body));
  if (!head) return null; // unreachable — the "" head always matches.

  // The head names the base quality; the shared modifier grammar realises the
  // alteration tail (the same tail the Roman parser reuses on its own head).
  const tail = applyModifierTail(head.quality, body.slice(head.suffix.length));
  if (!tail) return null; // unrecognised trailing text → typo.

  return {
    quality: head.quality,
    intervals: tail.intervals,
    suffix: qualitySymbol(head.quality) + tail.modSuffix,
  };
}

/**
 * Parse the chord part (root + body, no slash bass) into `ChordData`, or `null`
 * if unrecognised. The slash-bass handling lives in `parseChordSymbol`.
 */
function parseChordCore(s: string): ChordData | null {
  // Root: a letter A–G followed by any number of accidentals (# / b / ♯ / ♭).
  const m = /^([A-Ga-g])([#b♯♭]*)(.*)$/.exec(s);
  if (!m) return null;

  const letter = m[1]!.toUpperCase();
  const accidentals = m[2]!;
  const body = m[3]!;

  let root = LETTER_PC[letter]!;
  for (const ch of accidentals) {
    if (ch === "#" || ch === "♯") root += 1;
    else if (ch === "b" || ch === "♭") root -= 1;
  }
  root = ((root % 12) + 12) % 12;

  const parsed = parseBody(body);
  if (!parsed) return null;

  // Preserve the user's root spelling (so "Bbm7" stays "Bbm7", not "A#m7") and
  // append the canonical quality + modifier suffix.
  const rootText = letter + accidentals.replace(/♯/g, "#").replace(/♭/g, "b");
  const data: ChordData = {
    root,
    quality: parsed.quality,
    symbol: rootText + parsed.suffix,
  };
  if (parsed.intervals) data.intervals = parsed.intervals;
  return data;
}

/**
 * Parse a chord symbol string into `ChordData`, or `null` if unrecognised.
 * Supports an optional trailing `/X` slash bass (e.g. `"G/B"`, `"D/F#"`), split
 * on the LAST `/` and only when `X` parses as a bare note — so `"Eb6/9"` is a
 * 6/9 chord, not an E♭ over a `9` "bass".
 */
export function parseChordSymbol(input: string): ChordData | null {
  const s = input.trim();
  if (s.length === 0) return null;

  const slash = s.lastIndexOf("/");
  if (slash !== -1) {
    const bassText = s.slice(slash + 1).trim();
    const bass = parseNotePc(bassText);
    if (bass !== null) {
      const core = parseChordCore(s.slice(0, slash));
      if (!core) return null;
      const normalizedBassText = bassText
        .replace(/♯/g, "#")
        .replace(/♭/g, "b");
      return { ...core, bass, symbol: core.symbol + "/" + normalizedBassText };
    }
    // Tail isn't a note (e.g. the "9" in "6/9") — not a slash bass; fall through
    // and parse the whole string as the chord body.
  }

  return parseChordCore(s);
}
