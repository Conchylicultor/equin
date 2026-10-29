import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { upsertRow } from "@plugins/network/plugins/live/core";
import { chordModes } from "./resources";

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
  // The per-song row is an extension shape's (`from: null`): the collection is
  // the target; an absent row enters the by-id read the observer holds.
  effect: (on) =>
    upsertRow(
      on,
      chordModes,
      ({ params }) => params.id,
      (_row, { params, body }) => ({
        songId: params.id,
        enabled: body.enabled,
      }),
      { set: ({ body }) => ({ enabled: body.enabled }) },
    ),
});
