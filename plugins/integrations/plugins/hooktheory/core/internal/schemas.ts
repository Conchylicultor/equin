import { z } from "zod";
import { wholeList } from "@plugins/packages/plugins/list-bound/core";

// ── Chord ids and progressions ───────────────────────────────────────────────

/**
 * One chord in Hooktheory's trends vocabulary: "1", "4", "b7", "5/5", "56",
 * "L4", … Opaque on purpose — Hooktheory mixes scale degrees, inversion digits,
 * applied-chord slashes and mode prefixes, and nothing here interprets them. The
 * only rule enforced is the one the transport depends on: a progression is sent
 * comma-joined in `cp`, so an id can hold neither a comma nor whitespace.
 */
export const ChordIdSchema = z
  .string()
  .regex(
    /^[^,\s]+$/,
    "A Hooktheory chord id is non-empty, with no comma or whitespace",
  );

/** A chord progression, first chord first. */
export const ProgressionSchema = z.array(ChordIdSchema);

/** A progression as it travels in a `cp` query parameter: chord ids joined by commas. */
export const ProgressionParamSchema = z
  .string()
  .regex(
    /^[^,\s]+(,[^,\s]+)*$/,
    "cp is comma-separated Hooktheory chord ids, e.g. 1,4 or 1,b7,5/5",
  );

// ── Trends ───────────────────────────────────────────────────────────────────

/** One candidate next chord after a progression (`/trends/nodes`). */
export const TrendNodeSchema = z.object({
  /** The chord, in Hooktheory's id spelling — append it to the progression to go one step deeper. */
  chordId: ChordIdSchema,
  /** Hooktheory's display label for the chord, as HTML (it marks up inversions and extensions). */
  chordHtml: z.string(),
  /** Hooktheory's probability that this chord comes next. */
  probability: z.number(),
  /** Hooktheory's path for the progression extended by this chord. */
  childPath: z.string(),
});
export type TrendNode = z.infer<typeof TrendNodeSchema>;

/**
 * One song containing a progression (`/trends/songs`). The shape is Hooktheory's
 * documented one and is NOT yet confirmed against a live response — see this
 * plugin's CLAUDE.md.
 */
export const TrendSongSchema = z.object({
  artist: z.string(),
  song: z.string(),
  /** Which section of the song holds the progression ("Verse", "Chorus", …). */
  section: z.string(),
  /** The TheoryTab page for the song. */
  url: z.string(),
});
export type TrendSong = z.infer<typeof TrendSongSchema>;

// ── One TheoryTab section (a Hookpad document) ───────────────────────────────
//
// Every field type below was checked against 50 real sections (8 songs' pages,
// Hookpad document versions 1, 2.24.3 and 2.34.3). Only what a chord trainer
// needs is modelled; zod strips the rest of the editor state (bands, lyrics,
// cursor, settings, loopGui, mixer, …). Beats are 1-based and counted from the
// start of the section.

/** A TheoryTab section id — the short hash a TheoryTab page embeds per section (`_NgbRXeYgQA`). */
export const TheorytabSectionIdSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9_-]+$/,
    "A TheoryTab section id is letters, digits, '_' and '-'",
  );

// A chord's own lists are loaded whole wherever a live value carries a chord.
const CHORD_PART_REASON =
  "one chord's spelling: a handful of intervals or tones";

export const HookpadChordSchema = z.object({
  /** Scale degree of the root, 1–7 relative to the current key (0 on a rest). */
  root: z.number(),
  beat: z.number(),
  /** Length in beats. */
  duration: z.number(),
  /** Chord size: 5 = triad, 7 = seventh, 9 / 11 / 13 = extended. */
  type: z.number(),
  /** 0 = root position, 1 = first inversion, … */
  inversion: z.number(),
  /** 0 = not an applied chord; otherwise the function it borrows toward (5 = a V/x, 7 = a vii°/x, …). */
  applied: z.number(),
  /** Added intervals, e.g. [9], [6, 9]. */
  adds: wholeList(z.number(), { reason: CHORD_PART_REASON }),
  /** Omitted chord tones, e.g. [3], [5]. */
  omits: wholeList(z.number(), { reason: CHORD_PART_REASON }),
  /** Altered tones, e.g. ["#5"], ["b9"]. */
  alterations: wholeList(z.string(), { reason: CHORD_PART_REASON }),
  /** Suspensions, e.g. [4], [2]. */
  suspensions: wholeList(z.number(), { reason: CHORD_PART_REASON }),
  /**
   * Modal borrowing. `""` or `null` = not borrowed; a mode name ("minor",
   * "mixolydian", "dorian", … — a `HookpadMode`); or a custom scale as semitone
   * offsets from the tonic ([0, 2, 4, 5, 8, 9, 11]). Left an open string on
   * purpose: real documents hold odd values (`"super:2"`), and one odd chord
   * must not make its whole section unreadable — `hookpadChordSound` reports it
   * as unreadable instead.
   */
  borrowed: z
    .union([
      z.string(),
      wholeList(z.number(), {
        reason: "a custom scale: at most twelve semitone offsets",
      }),
    ])
    .nullable(),
  /** A rest: silence in the harmony track for `duration` beats. */
  isRest: z.boolean(),
  /**
   * A pedal tone. `null` in every chord seen (the whole Sheet Sage dump and the
   * live sample); typed open so a set one reaches `hookpadChordSound`, which
   * reports it as unreadable, rather than failing the section.
   */
  pedal: z.unknown(),
  /**
   * An alternate spelling. `""` almost always; 14 dump chords hold `"_"`, which
   * `hookpadChordSound` reports as unreadable, as Sheet Sage does.
   */
  alternate: z.string(),
});
export type HookpadChord = z.infer<typeof HookpadChordSchema>;

export const HookpadNoteSchema = z.object({
  /** Scale degree, with an accidental when chromatic: "1", "5", "b7", "#4". */
  sd: z.string(),
  /** Octave relative to the key's middle register (…, -1, 0, 1, …). */
  octave: z.number(),
  beat: z.number(),
  duration: z.number(),
  isRest: z.boolean(),
});
export type HookpadNote = z.infer<typeof HookpadNoteSchema>;

/**
 * The nine modes Hookpad offers, spelled as its documents spell them. A closed
 * list: every key in the Sheet Sage dump (26k sections) uses one of these, and
 * Sheet Sage's converter knows exactly these. A tenth mode from the live API
 * fails here, at the fetch boundary, naming the field.
 */
export const HookpadModeSchema = z.enum([
  "major",
  "minor",
  "dorian",
  "phrygian",
  "lydian",
  "mixolydian",
  "locrian",
  "harmonicMinor",
  "phrygianDominant",
]);
export type HookpadMode = z.infer<typeof HookpadModeSchema>;

/** A key (change) from `beat` on. */
export const HookpadKeySchema = z.object({
  beat: z.number(),
  scale: HookpadModeSchema,
  /** Tonic spelling: "C", "F#", "Bb", … */
  tonic: z.string(),
});
export type HookpadKey = z.infer<typeof HookpadKeySchema>;

/** A tempo (change) from `beat` on. */
export const HookpadTempoSchema = z.object({
  beat: z.number(),
  /**
   * Beats per minute. `null` in one dump document (`pJkmZPEjxqn`, whose melody
   * is broken too): nothing here reads the tempo to place a chord, so a missing
   * one must not refuse the section's harmony.
   */
  bpm: z.number().nullable(),
  swingFactor: z.number(),
  swingBeat: z.number(),
});
export type HookpadTempo = z.infer<typeof HookpadTempoSchema>;

/** A time signature (change) from `beat` on. */
export const HookpadMeterSchema = z.object({
  beat: z.number(),
  numBeats: z.number(),
  beatUnit: z.number(),
});
export type HookpadMeter = z.infer<typeof HookpadMeterSchema>;

/** The recording the section is transcribed from, and where in it the section sits. */
export const TheorytabYoutubeSchema = z.object({
  /**
   * What the transcriber pasted into Hookpad, verbatim: a bare video id, or a
   * full `youtube.com/watch?v=…` / `youtu.be/…` URL. `null` when nothing was
   * ever pasted (216 of the 26k sections in the Sheet Sage dump).
   */
  rawId: z.string().nullable(),
  /**
   * The 11-character video id pulled out of `rawId`, or `null` when `rawId` is
   * `null` or neither a bare id nor a YouTube URL this client recognises — the
   * section has no playable recording.
   */
  videoId: z.string().nullable(),
  /**
   * Start and end of the section in the recording. In every section sampled
   * these were fractions of the video's length (0–1), not seconds — converting
   * needs the video's duration from the player.
   */
  syncStart: z.number(),
  syncEnd: z.number(),
});
export type TheorytabYoutube = z.infer<typeof TheorytabYoutubeSchema>;

/**
 * One TheoryTab section: the harmony (`chords`), the melody (`notes`), the
 * key / tempo / meter maps, and the recording it lines up with.
 */
export const TheorytabSectionSchema = z.object({
  /** The section id it was fetched by. */
  id: TheorytabSectionIdSchema,
  /** The song title as TheoryTab lists it. */
  song: z.string(),
  chords: z.array(HookpadChordSchema),
  notes: z.array(HookpadNoteSchema),
  keys: z.array(HookpadKeySchema),
  tempos: z.array(HookpadTempoSchema),
  meters: z.array(HookpadMeterSchema),
  /** The beat the section ends on (exclusive): the last chord's `beat + duration`. */
  endBeat: z.number(),
  youtube: TheorytabYoutubeSchema,
});
export type TheorytabSection = z.infer<typeof TheorytabSectionSchema>;
