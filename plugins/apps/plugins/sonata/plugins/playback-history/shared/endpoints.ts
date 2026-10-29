import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { applyRows } from "@plugins/network/plugins/live/core";
import { playbackHistoryShape } from "./shape";

/**
 * Record one play of a song — increments its play count and stamps last-played.
 * Fired by the player on playback start (no body, idempotency is not desired:
 * each start is a play).
 */
export const recordPlay = defineEndpoint({
  route: "POST /api/sonata/songs/:id/play",
  // +1 on the playback slice the songs rows carry (the fields are EXPOSED on
  // the songs entity, under `$columns`), and stamp now — the server stamps its
  // own clock, so the shown time is approximate and the write confirms by
  // commit, not by value. A song row without the slice is left as it is.
  effect: (on) =>
    applyRows(
      on,
      playbackHistoryShape.exposure,
      ({ params }) => [params.id],
      (slices) =>
        slices.map((slice) => ({
          playCount: slice.playCount + 1,
          lastPlayedAt: new Date(),
        })),
    ),
});
