import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import {
  ChordLoopsAnswerSchema,
  FIND_LOOPS_ROUND_MAX,
  LoopFindOptionsSchema,
} from "@plugins/apps/plugins/chord/plugins/song-index/core";
import { CatalogStateSchema } from "./catalog";
import { SelectionSchema } from "./selection";

/**
 * What the learner has chosen, pushed again on every change. One object read
 * from one row, so no bound to state.
 *
 * No placeholder: until the server's first value lands the read is `pending`,
 * so the trainer renders its loading state rather than buttons that might be
 * about to change.
 */
export const chordCurriculum = liveValue("chord.curriculum", {
  schema: SelectionSchema,
});

/**
 * Every chord of the song index, in tracks and sections (`buildCatalog`):
 * `not-ready` until the index is loaded, then the catalog — pushed again when
 * a load finishes. One object, built once per loaded index; its size is the
 * index's distinct chords (1,808 on the full index, about 25 KB with the rare
 * groups' members), not anything the learner does.
 */
export const chordCatalog = liveValue("chord.catalog", {
  schema: CatalogStateSchema,
});

/**
 * A loop find over the learner's selection, as the trainer asks it: the find's
 * options (focus, shape, features, the sections to leave out, how many) plus
 * `round`, a nonce the trainer mints per refill — the answer is a random
 * sample, so one question asked twice must be two tuples. The chords are NOT
 * in the question: the server reads them from the stored selection, so the
 * question stays a few hundred bytes (well inside `LIVE_QUERY_MAX_BYTES`)
 * however many chords the learner turns on.
 */
export const CurriculumLoopsQuerySchema = LoopFindOptionsSchema.extend({
  round: z.string().min(1).max(FIND_LOOPS_ROUND_MAX),
});
export type CurriculumLoopsQueryInput = z.input<
  typeof CurriculumLoopsQuerySchema
>;

/**
 * Random loop windows for the learner's selection as it stands when the find
 * is answered (its practised and heard chords, its extras): `not-ready` (with
 * the index status) until the song index is loaded, then up to `limit`
 * candidates. On-demand and fixed per tuple, as song-index's `chord.loops`:
 * the next refill is a new round. A selection that moves after the answer
 * moves the trainer's palette, which drops the pool drawn for the old one.
 *
 * Refusals: `invalid-query` — nothing is practised, or the focus is not a
 * practised chord (the trainer's selection lagged the stored one).
 */
export const chordCurriculumLoops = liveValue("chord.curriculum.loops", {
  schema: ChordLoopsAnswerSchema,
  query: CurriculumLoopsQuerySchema,
  refusals: ["invalid-query"],
  load: "on-demand",
});
