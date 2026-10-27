import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import { cappedList } from "@plugins/packages/plugins/list-bound/core";
import { TheorytabSectionIdSchema } from "@plugins/integrations/plugins/hooktheory/core";
import {
  ChordFeatureSchema,
  LoopCandidateSchema,
  LoopExtrasSchema,
  LoopShapeIdSchema,
  NotReadySchema,
} from "./endpoints";
import { IndexStatusSchema } from "./index-status";
import { DEFAULT_LOOP_SHAPE } from "./loop-shapes";
import { ChordTokenSchema } from "./token";

/**
 * The live status. Reading it never starts work: only `ensure` does, so a debug
 * surface that shows it cannot trigger a download.
 *
 * No placeholder: until the server's first value lands the read is `pending`
 * (which is not `not-requested` — that is the server's answer).
 */
export const chordIndexStatus = liveValue("chord.index-status", {
  schema: IndexStatusSchema,
});

// ── The loop find ────────────────────────────────────────────────────────────

/** Most candidates one find returns. The trainer asks for a small batch, often. */
export const FIND_LOOPS_MAX_LIMIT = 50;

/**
 * Most sections one find may leave out. The trainer leaves out the last 20 it
 * played, the pool's and the round's (≤ 25 in all); the cap keeps the encoded
 * question well inside `LIVE_QUERY_MAX_BYTES` (a section id is 11 characters).
 */
export const FIND_LOOPS_MAX_EXCLUDED = 40;

/** The longest round nonce a find carries. */
export const FIND_LOOPS_ROUND_MAX = 64;

/**
 * What a find asks: random loop windows holding at least one practised chord,
 * whose other chords are playable — up to `extras` of them may be outside the
 * playable set. The two cross-field rules (every practised chord playable, the
 * focus practised) are checked by {@link checkFindLoops}, which refuses
 * `invalid-query`, not by this schema.
 */
export const FindLoopsSchema = z.object({
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
  excludeSectionIds: z
    .array(TheorytabSectionIdSchema)
    .min(1)
    .max(FIND_LOOPS_MAX_EXCLUDED)
    .optional(),
  limit: z.number().int().min(1).max(FIND_LOOPS_MAX_LIMIT),
});
export type FindLoops = z.infer<typeof FindLoopsSchema>;
export type FindLoopsInput = z.input<typeof FindLoopsSchema>;

/**
 * A find without its chord sets (`playable`, `practised`, `extras`): what a
 * question asks when its asker's server knows the chords — the curriculum's
 * `chord.curriculum.loops` reads them from the learner's stored selection, so
 * its question stays a few hundred bytes however many chords are on. Every
 * field here is bounded.
 */
export const LoopFindOptionsSchema = FindLoopsSchema.omit({
  playable: true,
  practised: true,
  extras: true,
});
export type LoopFindOptions = z.infer<typeof LoopFindOptionsSchema>;

/**
 * A find as the live value is asked it: the question plus `round`, a nonce the
 * asker mints per refill. The answer is a random sample, so one question asked
 * twice must be two tuples — a cached answer would deal the same loops again.
 */
export const FindLoopsQuerySchema = FindLoopsSchema.extend({
  round: z.string().min(1).max(FIND_LOOPS_ROUND_MAX),
});
export type FindLoopsQuery = z.infer<typeof FindLoopsQuerySchema>;
export type FindLoopsQueryInput = z.input<typeof FindLoopsQuerySchema>;

export const ChordLoopsAnswerSchema = z.discriminatedUnion("kind", [
  NotReadySchema,
  z.object({
    kind: z.literal("ready"),
    candidates: cappedList(LoopCandidateSchema, { max: FIND_LOOPS_MAX_LIMIT }),
  }),
]);
/** One loop find's answer: `not-ready` with the status, or the candidates. */
export type ChordLoopsAnswer = z.infer<typeof ChordLoopsAnswerSchema>;

/**
 * Random loop windows for one find over EXPLICIT chord sets
 * (`FindLoopsQuerySchema`) — for a caller naming a small set itself (the e2e
 * flows). Its question carries every chord, so it is bounded by
 * `LIVE_QUERY_MAX_BYTES`: the trainer, whose chord sets are the learner's
 * (unbounded) selection, asks the curriculum's `chord.curriculum.loops`
 * instead, which reads them on the server. `not-ready` (with
 * the status) until the index is loaded — never an empty list, which would
 * read as "no song fits" — then up to `limit` candidates.
 *
 * On-demand and fixed per tuple: a random sample of the windows, so nothing
 * pushes a change; the next refill is a new round, a new tuple.
 *
 * Refusals: `invalid-query` — a practised chord that is not playable, or a
 * focus that is not practised.
 */
export const chordLoops = liveValue("chord.loops", {
  schema: ChordLoopsAnswerSchema,
  query: FindLoopsQuerySchema,
  refusals: ["invalid-query"],
  load: "on-demand",
});

/**
 * Refuse (`invalid-query`) a find whose fields disagree: every practised chord
 * must be playable (a practised chord is one a loop may hold), and the focus
 * must be one of the practised chords.
 */
export function checkFindLoops(find: FindLoops): void {
  const unplayable = find.practised.filter((t) => !find.playable.includes(t));
  if (unplayable.length > 0) {
    throw chordLoops.refuse(
      "invalid-query",
      `every practised chord must be playable: a practised chord is one a loop may hold (not playable: ${unplayable.join(", ")})`,
    );
  }
  if (find.focus !== undefined && !find.practised.includes(find.focus)) {
    throw chordLoops.refuse(
      "invalid-query",
      `the focus ${find.focus} must be one of the practised chords`,
    );
  }
}
