import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

/**
 * Set a song's global transpose offset, in semitones (clamped to [-12, 12] — a
 * full octave each way). Upserts the per-song extension row; `0` restores the
 * original pitch.
 */
export const setTransposeEndpoint = defineEndpoint({
  route: "POST /api/sonata/songs/:id/transpose",
  body: z.object({ semitones: z.number().int().min(-12).max(12) }),
});
