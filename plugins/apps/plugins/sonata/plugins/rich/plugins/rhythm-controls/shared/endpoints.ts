import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { upsertRow } from "@plugins/network/plugins/live/core";
import { HandVoicingSchema, RhythmPatternSchema, rhythms } from "./resources";

/**
 * Set a song's groove: both hands' patterns, figuration ids and voicings,
 * whether a chord change restarts the necklace, and the groove preset it was
 * applied from (`null`: none).
 * Upserts the per-song extension row. The body is validated by
 * `RhythmPatternSchema` (onsets in range), so a malformed pattern is rejected
 * loudly rather than persisted.
 */
export const setRhythmEndpoint = defineEndpoint({
  route: "POST /api/sonata/songs/:id/rhythm",
  body: z.object({
    bass: RhythmPatternSchema,
    chord: RhythmPatternSchema,
    bassPatternId: z.string(),
    chordPatternId: z.string(),
    bassVoicing: HandVoicingSchema,
    chordVoicing: HandVoicingSchema,
    groovePresetId: z.string().nullable(),
    restartOnChordChange: z.boolean(),
  }),
  // The body is the whole row. The row is an extension shape's (`from: null`):
  // the collection is the target; an absent row enters the by-id read.
  effect: (on) =>
    upsertRow(
      on,
      rhythms,
      ({ params }) => params.id,
      (_row, { params, body }) => ({ songId: params.id, ...body }),
    ),
});
