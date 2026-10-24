import { z } from "zod";
import { wholeList } from "@plugins/packages/plugins/list-bound/core";

/**
 * The aligner's version: part of every stored record. Bump it when the
 * aligner's output improves or changes meaning — the job re-aligns a record of
 * an older version the next time it runs for that song. It does NOT decide
 * whether a record plays: an older record keeps playing as long as it still
 * lands on this sheet's chords (`fitsSheet`), so a new aligner never silences
 * the alignments already made. The record's indices point into the PARSED tab,
 * so a parser change that adds or drops lines can move them; each chord
 * segment carries the chord's `symbol` so `fitsSheet` can tell (2:
 * chord-substitution legend lines are no longer lines of the song).
 */
export const ALIGNER_VERSION = 2;

/** One sheet chord occurrence in the performance, over beat indices `[startBeat, endBeat)`. */
export const ChordSegmentSchema = z.object({
  kind: z.literal("chord"),
  /** Indices into the parsed tab: `sections[section].lines[line].chords[chord]`. */
  section: z.number().int().nonnegative(),
  line: z.number().int().nonnegative(),
  chord: z.number().int().nonnegative(),
  /**
   * The chord written at those indices when the record was made, so a parser
   * change that moves the indices is caught (`fitsSheet`). Absent on records
   * made before it was stored (aligner 1 and early 2).
   */
  symbol: z.string().optional(),
  /**
   * Which performance of its section this is (0-based, counting every time the
   * performance enters that sheet section — a "Chorus x2" yields 0 then 1).
   */
  occurrence: z.number().int().nonnegative(),
  startBeat: z.number().int().nonnegative(),
  endBeat: z.number().int().positive(),
});

/** A passage of the recording the sheet does not cover (intro, solo, outro…). */
export const GapSegmentSchema = z.object({
  kind: z.literal("gap"),
  startBeat: z.number().int().nonnegative(),
  endBeat: z.number().int().positive(),
});

export const AlignmentSegmentSchema = z.discriminatedUnion("kind", [
  ChordSegmentSchema,
  GapSegmentSchema,
]);
export type AlignmentSegment = z.infer<typeof AlignmentSegmentSchema>;

/**
 * Contract 2 of the Sonata sheet-alignment work
 * (`research/2026-09-29-apps-sonata-ug-sheet-alignment.md`): one sheet aligned
 * to one recording. Produced by `alignChords`, stored per song, read by the UG
 * `compile()` (via `alignedScore`) and, later, by video resolution (`score`).
 */
export const AlignmentRecordSchema = z.object({
  alignerVersion: z.number().int().positive(),
  videoId: z.string(),
  /** Which beat features it was computed from. */
  analysisVersion: z.number().int().positive(),
  settingsKey: z.string(),
  /** `sheetHash(tab.content)` of the sheet it was aligned against. */
  sheetHash: z.string(),
  durationSec: z.number().positive(),
  /** The beat grid used (the features' beats, chroma dropped). */
  beats: wholeList(
    z.object({ t: z.number().nonnegative(), downbeat: z.boolean() }),
    { reason: "one recording's beat grid — a song's beats" },
  ),
  /** Semitones: recording = sheet + transpose. In [0, 12); a capo shows up here. */
  transpose: z.number().int().min(0).max(11),
  /** Performance order, contiguous, covering beat indices `[0, beats.length)`. */
  segments: wholeList(AlignmentSegmentSchema, {
    reason: "one alignment's performance-order segments — a song's sections",
  }),
  /** One per bar (downbeat to next downbeat; the beats before the first downbeat form bar 0), 0–1. */
  barConfidence: wholeList(z.number().min(0).max(1), {
    reason: "one per bar of one recording",
  }),
  /**
   * Overall fit, 0–1: what candidates are compared with. How much of the
   * achievable chord fit the sheet's sequence explains, times the fraction of
   * the sheet's chords the performance plays (see `align.ts`).
   */
  score: z.number().min(0).max(1),
});
export type AlignmentRecord = z.infer<typeof AlignmentRecordSchema>;

/**
 * Below this overall `score` an alignment is a weak match: the resolver keeps
 * looking for a better video (`walkCandidates`). It is still applied to the
 * Score — the song plays on its best try, labelled unconfirmed — so this
 * decides only the search, never the playing. Calibrated on the calibration
 * set (`scripts/calibrate.ts --set`, results in
 * research/2026-10-07-apps-sonata-ug-alignment-scoring.md): every right
 * recording scores at least 0.68. Sheets built on a common progression
 * (I–V–vi–IV) also fit other songs' recordings, and 6 of 169 wrong pairs
 * reach 0.6; the resolver only aligns videos that already matched the song's
 * title and artist, so the threshold guards against a wrong video of the
 * song, not against every other song.
 */
export const WEAK_MATCH_THRESHOLD = 0.6;

/**
 * Stable hash of a sheet's markup: a record applies only to the exact sheet it
 * was aligned against. FNV-1a 64-bit, hex — pure and synchronous so the browser
 * `compile()` can check it.
 */
export function sheetHash(content: string): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < content.length; i++) {
    h ^= BigInt(content.charCodeAt(i));
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, "0");
}
