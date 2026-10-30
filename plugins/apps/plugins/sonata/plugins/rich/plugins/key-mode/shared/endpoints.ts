import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

/**
 * Set a song's key-auto-detect override. `enabled: true` makes the player treat
 * the song as keyless (re-infer the key from notes, re-spell, re-analyze);
 * `false` restores the authored key. Upserts the per-song extension row.
 */
export const setKeyAutoDetectEndpoint = defineEndpoint({
  route: "POST /api/sonata/songs/:id/key-auto-detect",
  body: z.object({ enabled: z.boolean() }),
});
