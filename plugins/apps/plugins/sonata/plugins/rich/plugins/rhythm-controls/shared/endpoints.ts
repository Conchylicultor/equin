import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { HandVoicingSchema, RhythmPatternSchema } from "./resources";

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
});
