import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

/**
 * Record one play of a song — increments its play count and stamps last-played.
 * Fired by the player on playback start (no body, idempotency is not desired:
 * each start is a play).
 */
export const recordPlay = defineEndpoint({
  route: "POST /api/sonata/songs/:id/play",
});
