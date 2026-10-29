import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { upsertRow } from "@plugins/network/plugins/live/core";
import { transposes } from "./resources";

/**
 * Set a song's global transpose offset, in semitones (clamped to [-12, 12] — a
 * full octave each way). Upserts the per-song extension row; `0` restores the
 * original pitch.
 */
export const setTransposeEndpoint = defineEndpoint({
  route: "POST /api/sonata/songs/:id/transpose",
  body: z.object({ semitones: z.number().int().min(-12).max(12) }),
  // The per-song row is an extension shape's (`from: null`): the collection is
  // the target. The request decides the whole row; an absent row enters the
  // by-id read the observer holds.
  effect: (on) =>
    upsertRow(
      on,
      transposes,
      ({ params }) => params.id,
      (_row, { params, body }) => ({
        songId: params.id,
        semitones: body.semitones,
      }),
      { set: ({ body }) => ({ semitones: body.semitones }) },
    ),
});
