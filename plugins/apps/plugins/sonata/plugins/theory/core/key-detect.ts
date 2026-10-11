/**
 * Key inference — "what key is this music in?", derived purely from the notes.
 *
 * Most MIDI files carry no key header (`score.meta.key` is empty), so to spell
 * accidentals and chord roots correctly we must *infer* the tonal centre from
 * the pitches themselves. This module implements the classic Krumhansl–Schmuckler
 * algorithm: build a duration-weighted pitch-class histogram and correlate it
 * against the Krumhansl–Kessler "key profiles" (empirically-derived tonal
 * hierarchies). The profile that best correlates names the key.
 *
 * Inference starts from the whole-score key and changes it only on clear
 * evidence (a multi-bar window that leaves the key in force well behind), so a
 * piece that modulates emits a `key` annotation at each region boundary while a
 * diatonic one keeps a single key; a single `effectiveKeyAt(score, beat)`
 * resolver downstream then spells every note/chord in *its* section's key.
 *
 * Pure TypeScript: no React, no framework. Imports only `score/core` — `theory`
 * may depend on `score`, never the reverse, so the DAG stays acyclic.
 */

import {
  bars,
  type Annotation,
  type KeySignature,
  type Score,
} from "@plugins/apps/plugins/sonata/plugins/score/core";

// ---------------------------------------------------------------------------
// Tunable constants
// ---------------------------------------------------------------------------

/**
 * Confidence floor (atonal guard). If the whole-score best correlation is below
 * this, the content is too tonally ambiguous (atonal, percussive, a chromatic
 * cluster) to name a key — we infer nothing and leave today's normalized-sharps
 * behaviour in place. Pearson correlation ranges [-1, 1]; a clearly-tonal piece
 * scores well above 0.7 against its true key, so 0.5 separates real keys from
 * noise without rejecting genuine but weakly-stated tonality.
 */
const CONFIDENCE_FLOOR = 0.5;

/**
 * Minimum length (in bars) of an inferred key region — a phrase. Shorter
 * "modulations" are a passing harmony (a borrowed chord, a secondary dominant),
 * not a new tonal centre; they fold into a neighbouring region.
 */
const MIN_REGION_BARS = 4;

/**
 * How many bars of music decide a bar's key: a window of this many bars
 * centred on it. One bar is too little evidence — a bar that is all Bm7 in a
 * D-major song scores best as B minor, because a key's relative and its
 * one-accidental neighbours share almost all its pitches.
 */
const MODULATION_WINDOW_BARS = 4;

/**
 * Hysteresis: a window leaves the key in force only when its best key beats
 * THAT key's own correlation on the window by at least this much. Being the
 * argmax is not enough — a diatonic song's relative / neighbour keys are near
 * ties with its home key on any short stretch, while a genuine modulation
 * (new accidentals) leaves the old key far behind.
 */
const MODULATION_MARGIN = 0.1;

/**
 * Krumhansl–Kessler key profiles — the empirically-measured "tonal hierarchy":
 * for a given mode, the relative perceptual stability of each scale degree,
 * indexed by semitones above the tonic (0 = tonic, 1 = ♭2/♯1, … 11 = leading
 * tone). The tonic, dominant (7) and mediant (3/4) dominate; chromatic degrees
 * sit low. We correlate a histogram (rotated so index 0 = the candidate tonic)
 * against these to score how well that tonic explains the music.
 */
const MAJOR_PROFILE: readonly number[] = [
  6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88,
];
const MINOR_PROFILE: readonly number[] = [
  6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17,
];

/**
 * Conventional key NAME per `(pitch-class, mode)`, chosen as the spelling with
 * the *fewest accidentals* — never nonsense like "B#"/"G#" major. `makeKeySpeller`
 * downstream derives the whole signature from this tonic string, so it must be a
 * sane enharmonic key. Major and minor differ where the fewest-accidental choice
 * differs (e.g. pc 1 is D♭ major but C♯ minor; pc 6 is F♯ in both; pc 8 is A♭
 * major but G♯ minor).
 */
const MAJOR_NAMES: readonly string[] = [
  "C",
  "Db",
  "D",
  "Eb",
  "E",
  "F",
  "F#",
  "G",
  "Ab",
  "A",
  "Bb",
  "B",
];
const MINOR_NAMES: readonly string[] = [
  "C",
  "C#",
  "D",
  "Eb",
  "E",
  "F",
  "F#",
  "G",
  "G#",
  "A",
  "Bb",
  "B",
];

// ---------------------------------------------------------------------------
// Histogram + correlation
// ---------------------------------------------------------------------------

/**
 * Duration-weighted pitch-class histogram over `[start, end)`. Each sounding
 * note contributes the length of its overlap with the window into `hist[pitch %
 * 12]` — weighting by *time sounded*, not note count, so a held whole note
 * matters more than a passing sixteenth. A note that only partially overlaps the
 * window contributes only its overlapping fraction.
 */
function windowHistogram(score: Score, start: number, end: number): number[] {
  const hist = new Array<number>(12).fill(0);
  for (const n of score.notes) {
    const noteStart = n.start;
    const noteEnd = n.start + n.duration;
    const overlap = Math.min(noteEnd, end) - Math.max(noteStart, start);
    if (overlap <= 0) continue;
    const pc = ((n.pitch % 12) + 12) % 12;
    hist[pc]! += overlap;
  }
  return hist;
}

/**
 * Pearson correlation coefficient between two equal-length numeric vectors.
 * Returns 0 for a degenerate (zero-variance) vector — e.g. a silent window or a
 * single-pitch drone — so such windows fall below the confidence floor rather
 * than producing a spurious NaN-driven "key".
 */
function pearson(a: readonly number[], b: readonly number[]): number {
  const n = a.length;
  let sumA = 0;
  let sumB = 0;
  for (let i = 0; i < n; i++) {
    sumA += a[i]!;
    sumB += b[i]!;
  }
  const meanA = sumA / n;
  const meanB = sumB / n;

  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i]! - meanA;
    const db = b[i]! - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  if (varA === 0 || varB === 0) return 0;
  return cov / Math.sqrt(varA * varB);
}

/** The best (pc, mode) key for a histogram, with its correlation strength. */
interface KeyGuess {
  pc: number;
  mode: "major" | "minor";
  correlation: number;
}

/**
 * Score all 24 keys against `hist` and return the best. For each candidate tonic
 * `t`, we correlate the profile against the histogram *rotated* so index 0 reads
 * the candidate tonic's pitch-class (i.e. compare `profile[i]` to `hist[(t + i)
 * % 12]`). Best = highest Pearson correlation across both modes and all tonics.
 */
function bestKey(hist: readonly number[]): KeyGuess {
  let best: KeyGuess = { pc: 0, mode: "major", correlation: -Infinity };

  for (let t = 0; t < 12; t++) {
    for (const mode of ["major", "minor"] as const) {
      const correlation = keyCorrelation(hist, t, mode);
      if (correlation > best.correlation) best = { pc: t, mode, correlation };
    }
  }

  return best;
}

/**
 * How well one key `(pc, mode)` explains `hist`: the Pearson correlation of its
 * profile against the histogram rotated so index 0 reads the tonic `pc`.
 */
function keyCorrelation(
  hist: readonly number[],
  pc: number,
  mode: "major" | "minor",
): number {
  const rotated = new Array<number>(12);
  for (let i = 0; i < 12; i++) rotated[i] = hist[(pc + i) % 12]!;
  return pearson(mode === "major" ? MAJOR_PROFILE : MINOR_PROFILE, rotated);
}

const sameKey = (a: { pc: number; mode: string }, b: typeof a) =>
  a.pc === b.pc && a.mode === b.mode;

/**
 * Whether two keys share one key signature — the same key, or a key and its
 * relative (a minor tonic 9 semitones above its relative major's). Their scales
 * are the same seven pitch classes, so a window's histogram cannot tell them
 * apart reliably: a passage dwelling on vi is not a modulation to the relative
 * minor. Which of the two the song is in is decided once, on the whole score.
 */
function sameSignature(
  a: { pc: number; mode: "major" | "minor" },
  b: typeof a,
): boolean {
  const majorPc = (k: typeof a) =>
    k.mode === "major" ? k.pc : (k.pc + 3) % 12;
  return majorPc(a) === majorPc(b);
}

/**
 * Merge adjacent regions in the same key into one, in place — the region of a
 * run of bars that never changed key is ONE region, never several flush ones.
 */
function coalesceRegions(regions: Region[]): void {
  for (let i = regions.length - 1; i > 0; i--) {
    const prev = regions[i - 1]!;
    const r = regions[i]!;
    if (!sameKey(prev, r)) continue;
    prev.toBar = r.toBar;
    regions.splice(i, 1);
  }
}

/**
 * Conventional, fewest-accidental tonic name for a `(pc, mode)` pair. Exported
 * so the fewest-accidental naming table has ONE home, reused by both `inferKeys`
 * (here) and `transposeScore`/`transposeKey` (sibling `transpose.ts`).
 */
export function tonicName(pc: number, mode: "major" | "minor"): string {
  return (mode === "major" ? MAJOR_NAMES : MINOR_NAMES)[pc]!;
}

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
 * Inverse of `tonicName`: a bare note/tonic name (letter + accidentals, e.g.
 * "C", "F#", "B♭") → its pitch-class in [0, 12). Unknown leading letters fall
 * back to C(0); each `#`/`♯` shifts +1 and each `b`/`♭` −1. The single home for
 * the name→pc parse, reused by `transposeScore`/`transposeKey` (sibling
 * `transpose.ts`) and the key readout.
 */
export function tonicPc(name: string): number {
  let pc = LETTER_PC[name[0]?.toUpperCase() ?? "C"] ?? 0;
  for (const ch of name.slice(1)) {
    if (ch === "#" || ch === "♯") pc += 1;
    else if (ch === "b" || ch === "♭") pc -= 1;
  }
  return ((pc % 12) + 12) % 12;
}

// ---------------------------------------------------------------------------
// inferKeys
// ---------------------------------------------------------------------------

/** A window over a single bar (or the whole score in the fallback case). */
interface Window {
  start: number;
  end: number;
}

/** A run of consecutive bars sharing the same inferred key. */
interface Region {
  /** Index into the bar windows where the region starts (inclusive). */
  fromBar: number;
  /** Index where the region ends (exclusive). */
  toBar: number;
  pc: number;
  mode: "major" | "minor";
  /** How well the region's key explains its whole span, as confidence. */
  correlation: number;
}

/**
 * Infer the song's key(s) from its notes and emit `source:"derived"` `key`
 * annotations — one per inferred region, including the first at its start beat.
 *
 * Returns the score UNCHANGED when:
 *  - the score already has an authored key (`meta.key` set, or any authored
 *    `key` annotation) AND `opts.force` is not set — by default we trust
 *    authored truth; modulation inference over header-keyed files is a later
 *    improvement; or
 *  - the whole-score best correlation is below the confidence floor (atonal /
 *    percussive / ambiguous) — graceful degradation to normalized-only.
 *
 * With `opts.force` (the per-song "auto-detect key" override), any authored key
 * is FIRST stripped — `meta.key` cleared and authored `key` annotations dropped —
 * so the song is treated as keyless and the key is inferred from the notes. This
 * makes the whole downstream pipeline (note spelling, chord analysis, the
 * readout) use the inferred key, exactly as it would for a genuinely keyless
 * song. Outside `force`, never touches `meta.key`; only appends annotations.
 */
export function inferKeys(score: Score, opts?: { force?: boolean }): Score {
  // 1. Authored truth. By default, bail if a key is already declared. With
  // `force`, instead strip it so inference below replaces it (and so the
  // `hasAuthoredKey` check downstream sees a clean, keyless score).
  const hasAuthoredKey =
    score.meta.key !== undefined ||
    score.annotations.some((a) => a.type === "key" && a.source === "authored");
  if (hasAuthoredKey) {
    if (!opts?.force) return score;
    score = {
      ...score,
      meta: { ...score.meta, key: undefined },
      annotations: score.annotations.filter(
        (a) => !(a.type === "key" && a.source === "authored"),
      ),
    };
  }

  if (score.notes.length === 0) return score;

  // The last beat any note sounds — closes the final bar's window.
  let scoreEnd = 0;
  for (const n of score.notes)
    scoreEnd = Math.max(scoreEnd, n.start + n.duration);

  // 2. Windows: one per bar `[barStart, nextBarStart)`, the last closing at the
  // score's end. With too few bars to window meaningfully, fall back to a single
  // whole-score window.
  const barStarts = bars(score).map((b) => b.startBeat);
  let windows: Window[];
  if (barStarts.length < 2) {
    windows = [{ start: 0, end: scoreEnd }];
  } else {
    windows = barStarts.map((start, i) => ({
      start,
      end: i + 1 < barStarts.length ? barStarts[i + 1]! : scoreEnd,
    }));
  }

  // 5a. Confidence floor (atonal guard) — compute a GLOBAL histogram over the
  // whole score; if even its best key is weak, the content has no usable tonal
  // centre, so infer nothing.
  const globalHist = windowHistogram(score, 0, scoreEnd);
  const globalBest = bestKey(globalHist);
  if (globalBest.correlation < CONFIDENCE_FLOOR) return score;

  // 3–5. Per-bar key, with hysteresis. The key in force starts as the
  // whole-score key; each bar's evidence is the `MODULATION_WINDOW_BARS`-bar
  // window centred on it, and the key changes only when that window's best key
  // has a different key signature, clears the in-force key's own correlation
  // there by `MODULATION_MARGIN`, and is itself above the floor. A diatonic
  // song thus keeps its one key however its bars lean, while a real modulation
  // still lands at its phrase.
  const before = Math.floor(MODULATION_WINDOW_BARS / 2);
  const after = MODULATION_WINDOW_BARS - before;
  const perBar: KeyGuess[] = [];
  let current: KeyGuess = globalBest;
  for (let i = 0; i < windows.length; i++) {
    const from = windows[Math.max(0, i - before)]!.start;
    const to = windows[Math.min(windows.length, i + after) - 1]!.end;
    const hist = windowHistogram(score, from, to);
    const guess = bestKey(hist);
    if (
      !sameSignature(guess, current) &&
      guess.correlation >= CONFIDENCE_FLOOR &&
      guess.correlation - keyCorrelation(hist, current.pc, current.mode) >=
        MODULATION_MARGIN
    ) {
      // The centred window only clears the margin once most of it is past the
      // change, so pull the boundary back over the bars just before that
      // already sound more like the new key than the old one.
      for (let j = i - 1; j >= Math.max(0, i - before); j--) {
        const bar = windowHistogram(score, windows[j]!.start, windows[j]!.end);
        const prior = perBar[j]!;
        if (
          keyCorrelation(bar, guess.pc, guess.mode) <=
          keyCorrelation(bar, prior.pc, prior.mode)
        )
          break;
        perBar[j] = guess;
      }
      current = guess;
    }
    perBar.push(current);
  }

  // 6a. Consecutive bars with the same (pc, mode) form one region.
  const regions: Region[] = perBar.map((g, i) => ({
    fromBar: i,
    toBar: i + 1,
    pc: g.pc,
    mode: g.mode,
    correlation: g.correlation,
  }));
  coalesceRegions(regions);

  // 6b. Smooth: fold each sub-`MIN_REGION_BARS` region into the PRECEDING
  // region (or the FOLLOWING one, for a too-short first region), re-coalescing
  // after every fold — a fold can leave two regions in the same key side by
  // side, and those are one region. Iterate to a fixed point.
  for (;;) {
    const i = regions.findIndex((r) => r.toBar - r.fromBar < MIN_REGION_BARS);
    if (i === -1 || regions.length < 2) break;
    const r = regions[i]!;
    if (i > 0) regions[i - 1]!.toBar = r.toBar;
    else regions[i + 1]!.fromBar = r.fromBar;
    regions.splice(i, 1);
    coalesceRegions(regions);
  }

  // 7. Major or relative minor, decided on each region's whole span. Regions
  // are told apart by key signature only, and the window that opened one may
  // still have held bars of the previous key — so its own mode guess is not
  // the region's.
  for (const r of regions) {
    const hist = windowHistogram(
      score,
      windows[r.fromBar]!.start,
      windows[r.toBar - 1]!.end,
    );
    const majorPc = r.mode === "major" ? r.pc : (r.pc + 3) % 12;
    const minorPc = (majorPc + 9) % 12;
    const major = keyCorrelation(hist, majorPc, "major");
    const minor = keyCorrelation(hist, minorPc, "minor");
    const isMinor = minor > major;
    r.pc = isMinor ? minorPc : majorPc;
    r.mode = isMinor ? "minor" : "major";
    r.correlation = isMinor ? minor : major;
  }

  // 8. Spell each region's tonic and emit a derived `key` annotation. The
  // region spans `[firstBarStart, lastBarEnd)` in beats.
  const keyAnnotations: Annotation[] = regions.map((r) => {
    const startBeat = windows[r.fromBar]!.start;
    const endBeat = windows[r.toBar - 1]!.end;
    const tonic = tonicName(r.pc, r.mode);
    return {
      type: "key",
      start: startBeat,
      end: endBeat,
      data: { tonic, mode: r.mode } satisfies KeySignature,
      source: "derived",
      // Pearson correlation is in [-1, 1]; we only reach here above the floor
      // (≥ 0.5), so clamp to [0, 1] for a presentable confidence.
      confidence: Math.max(0, Math.min(1, r.correlation)),
    };
  });

  return {
    ...score,
    annotations: [...score.annotations, ...keyAnnotations],
  };
}
