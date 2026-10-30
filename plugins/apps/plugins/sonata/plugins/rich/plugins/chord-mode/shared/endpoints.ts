import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

/**
 * Set a song's chord mode. `enabled: true` makes the player voice the song's
 * detected chords onto the Chords / Bass tracks; `false` removes them again.
 * Upserts the per-song extension row. (Turning the original tracks off / on is
 * a separate track-mixer write the toggle issues alongside — this endpoint owns
 * only the mode flag.)
 */
export const setChordModeEndpoint = defineEndpoint({
  route: "POST /api/sonata/songs/:id/chord-mode",
  body: z.object({ enabled: z.boolean() }),
});
