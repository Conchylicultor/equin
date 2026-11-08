import { liveCollection } from "@plugins/network/plugins/live/core";
import { songsEntityRef } from "@plugins/apps/plugins/sonata/plugins/library/core";

// What a `song-…` chip shows, by song id — lookup-only, a FOLLOW target: a
// live value showing stored text with its chips as their titles (a backlink's
// snippet) follows the songs its text names (inline-chip's
// `followedReferent`). The row is exactly what `resolveSongReferent` reads,
// so only a retitle refills it.
export const songChipReferents = liveCollection("song-chip.referents", {
  from: songsEntityRef,
  carry: { pick: ["id", "title"] },
  baseExposures: false,
  id: "id",
});
