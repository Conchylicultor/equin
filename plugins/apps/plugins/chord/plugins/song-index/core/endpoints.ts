import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import {
  HookpadModeSchema,
  TheorytabSectionIdSchema,
  type HookpadMode,
} from "@plugins/integrations/plugins/hooktheory/core";
import { VideoStatusSchema } from "@plugins/apps/plugins/chord/plugins/video-availability/core";
import { AlignmentSchema } from "./beat-time";
import { CHORD_FEATURES } from "./features";
import { IndexStatusSchema } from "./index-status";
import { DEFAULT_LOOP_SHAPE, LOOP_SHAPE_IDS } from "./loop-shapes";
import { NextChordCountSchema } from "./next-chords";
import { TokenizedChordSchema } from "./stored-chord";
import { ChordTokenSchema, type ChordToken } from "./token";

// ── The index's HTTP surface ─────────────────────────────────────────────────
//
// Both reads answer `not-ready` (with the status) until the index is loaded —
// never an empty list, which would read as "no song fits".

/**
 * Open the index: record that this instance uses the app, and start a load
 * when the index is missing, stale (another snapshot, scope or derivation
 * version) or failed. Idempotent — a second call while a load runs joins it.
 */
export const ensureChordIndexEndpoint = defineEndpoint({
  route: "POST /api/chord/index/ensure",
  response: IndexStatusSchema,
});

const ChordFeatureSchema = z.enum(CHORD_FEATURES);
const LoopShapeIdSchema = z.enum(LOOP_SHAPE_IDS);

/** A loop window as the trainer ranks and plays it. Beats are Hookpad's, 1-based. */
export const LoopWindowFieldsSchema = z.object({
  shape: LoopShapeIdSchema,
  startBeat: z.number(),
  endBeat: z.number(),
  bars: z.number().int(),
  beatsPerBar: z.number(),
  beatUnit: z.number(),
  keyTonic: z.string(),
  keyMode: HookpadModeSchema,
  chordTokens: z.array(ChordTokenSchema),
  features: z.array(ChordFeatureSchema),
  chordCount: z.number().int(),
  changeCount: z.number().int(),
  hasRest: z.boolean(),
  startsOnChange: z.boolean(),
  /** `isRichLoop`: a real progression, which `find` serves first. */
  rich: z.boolean(),
});

export const LoopCandidateSchema = z.object({
  sectionId: TheorytabSectionIdSchema,
  artist: z.string(),
  song: z.string(),
  sectionName: z.string(),
  /** Every window has a video: a section without one has no windows. */
  videoId: z.string(),
  /** From the dump, when it knew it. A video-fraction alignment needs it (or the player's). */
  videoDurationSeconds: z.number().nullable(),
  /**
   * What is known about the video, as of this answer: `ok` (checked, it plays)
   * or `unknown` (nobody could tell yet). Never `gone` or `not-embeddable` —
   * `find` leaves those out.
   */
  videoStatus: VideoStatusSchema,
  alignment: AlignmentSchema,
  window: LoopWindowFieldsSchema,
  /** The section's chords overlapping the window (one ringing in from before counts), in beat order. */
  chords: z.array(TokenizedChordSchema),
});
export type LoopCandidate = z.infer<typeof LoopCandidateSchema>;

const NotReadySchema = z.object({
  kind: z.literal("not-ready"),
  status: IndexStatusSchema,
});

/** Most candidates one find returns. The trainer asks for a small batch, often. */
export const FIND_LOOPS_MAX_LIMIT = 50;

/**
 * How many chords outside the playable set a loop may hold: `0` (every chord
 * playable), at most `1` or `2`, or `any`. The learner's "Other chords per
 * loop" setting.
 */
export const LOOP_EXTRAS = [0, 1, 2, "any"] as const;
export const LoopExtrasSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal("any"),
]);
export type LoopExtras = z.infer<typeof LoopExtrasSchema>;

export const FindLoopsBodySchema = z
  .object({
    /** The chords a loop may hold: practised and heard. */
    playable: z.array(ChordTokenSchema).min(1),
    /** The practised chords: every returned window holds at least one. Each must be playable. */
    practised: z.array(ChordTokenSchema).min(1),
    /** How many chords outside `playable` a window may hold besides. */
    extras: LoopExtrasSchema,
    /** Keep only windows holding this chord. Must be practised. */
    focus: ChordTokenSchema.optional(),
    shape: LoopShapeIdSchema.default(DEFAULT_LOOP_SHAPE),
    /** Keep windows whose spelling has every one of these features. */
    requireFeatures: z.array(ChordFeatureSchema).min(1).optional(),
    /** Drop windows whose spelling has any of these features. */
    forbidFeatures: z.array(ChordFeatureSchema).min(1).optional(),
    /** Sections to leave out (recently played). */
    excludeSectionIds: z.array(TheorytabSectionIdSchema).min(1).optional(),
    limit: z.number().int().min(1).max(FIND_LOOPS_MAX_LIMIT),
  })
  .refine(
    (body) => body.practised.every((token) => body.playable.includes(token)),
    {
      message:
        "every practised chord must be playable: a practised chord is one a loop may hold",
      path: ["practised"],
    },
  )
  .refine(
    (body) => body.focus === undefined || body.practised.includes(body.focus),
    {
      message: "focus must be one of the practised chords",
      path: ["focus"],
    },
  );
export type FindLoopsBody = z.infer<typeof FindLoopsBodySchema>;

/**
 * Random loop windows holding at least one practised chord, whose other chords
 * are playable — up to `extras` of them may be outside the playable set.
 */
export const findLoopsEndpoint = defineEndpoint({
  route: "POST /api/chord/loops/find",
  body: FindLoopsBodySchema,
  response: z.discriminatedUnion("kind", [
    NotReadySchema,
    z.object({
      kind: z.literal("ready"),
      candidates: z.array(LoopCandidateSchema),
    }),
  ]),
});

export const NEXT_CHORDS_MAX_LIMIT = 200;

export const NextChordsBodySchema = z.object({
  unlocked: z.array(ChordTokenSchema).min(1),
  shape: LoopShapeIdSchema.default(DEFAULT_LOOP_SHAPE),
  /**
   * Scan only the windows in these modes; absent = every mode. The counts come
   * back split by mode either way, so narrowing here only saves the scan.
   */
  modes: z.array(HookpadModeSchema).min(1).optional(),
  limit: z.number().int().min(1).max(NEXT_CHORDS_MAX_LIMIT).default(20),
});
export type NextChordsBody = z.infer<typeof NextChordsBodySchema>;

/**
 * For each chord outside the unlocked set, how many windows unlocking it would
 * add: windows made of unlocked chords plus exactly that one, counted per key
 * mode. The chord with the largest single-mode count comes first.
 */
export const nextChordsEndpoint = defineEndpoint({
  route: "POST /api/chord/loops/next-chords",
  body: NextChordsBodySchema,
  response: z.discriminatedUnion("kind", [
    NotReadySchema,
    z.object({
      kind: z.literal("ready"),
      nextChords: z.array(NextChordCountSchema),
    }),
  ]),
});

export const CountLoopsInSetBodySchema = z.object({
  /** The chords to count against: a window counts when every chord of it is one of these. */
  unlocked: z.array(ChordTokenSchema).min(1),
  shape: LoopShapeIdSchema.default(DEFAULT_LOOP_SHAPE),
  /** Count only windows in these modes; absent = every mode. */
  modes: z.array(HookpadModeSchema).min(1).optional(),
});
export type CountLoopsInSetBody = z.infer<typeof CountLoopsInSetBodySchema>;

/**
 * How many windows are made only of the chords in this set: what a learner
 * holding exactly these chords could be given.
 *
 * The third of the index's reads, and the HTTP twin of the server barrel's
 * `countLoopsInSet` — which the curriculum calls in process to rank a whole
 * family's seed ("what would minor keys open?"), a question `next-chords`
 * cannot answer because it counts one chord at a time. Over HTTP it is what
 * lets a client ask the same thing about a set the learner does not have,
 * which is how `curriculum/e2e/ladder-preview.ts` walks the ladder without
 * unlocking anything.
 *
 * Like `next-chords` it ignores the videos: it ranks a step rather than
 * promising the learner a number of songs.
 */
export const countLoopsInSetEndpoint = defineEndpoint({
  route: "POST /api/chord/loops/count-in-set",
  body: CountLoopsInSetBodySchema,
  response: z.discriminatedUnion("kind", [
    NotReadySchema,
    z.object({
      kind: z.literal("ready"),
      windows: z.number().int().min(0),
    }),
  ]),
});

/**
 * One distinct (key mode, chord set) of the windows of a shape, and how many
 * windows have it: the rows of the server's `countTokenSets`, which the
 * curriculum builds its catalog from.
 */
export type TokenSetCount = {
  mode: HookpadMode;
  tokens: readonly ChordToken[];
  windows: number;
};
