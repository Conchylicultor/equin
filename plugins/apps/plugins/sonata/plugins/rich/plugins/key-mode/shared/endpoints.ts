import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { upsertRow } from "@plugins/network/plugins/live/core";
import { keyAutoDetects } from "./resources";

/**
 * Set a song's key-auto-detect override. `enabled: true` makes the player treat
 * the song as keyless (re-infer the key from notes, re-spell, re-analyze);
 * `false` restores the authored key. Upserts the per-song extension row.
 */
export const setKeyAutoDetectEndpoint = defineEndpoint({
  route: "POST /api/sonata/songs/:id/key-auto-detect",
  body: z.object({ enabled: z.boolean() }),
  // The per-song row is an extension shape's (`from: null`): the collection is
  // the target; an absent row enters the by-id read the observer holds.
  effect: (on) =>
    upsertRow(
      on,
      keyAutoDetects,
      ({ params }) => params.id,
      (_row, { params, body }) => ({
        songId: params.id,
        enabled: body.enabled,
      }),
      { set: ({ body }) => ({ enabled: body.enabled }) },
    ),
});
