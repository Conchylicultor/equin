import { liveCollection } from "@plugins/network/plugins/live/core";
import { beforeAfterPairsEntityRef } from "@plugins/conversations/plugins/before-after/core";

// What a `ba-…` chip shows, by pair id — lookup-only, a FOLLOW target: a live
// value showing stored text with its chips as their titles follows the pairs
// its text names (inline-chip's `followedReferent`). Its own collection rather
// than `before-after.pairs`: that one reaches its entity's exposures, so it
// compiles at `bindDeferredResources` — a follower binding before it finds it
// unbound. The row is exactly what `resolveBeforeAfterReferent` reads.
export const beforeAfterChipReferents = liveCollection(
  "before-after-chip.referents",
  {
    from: beforeAfterPairsEntityRef,
    carry: { pick: ["id", "title"] },
    baseExposures: false,
    id: "id",
  },
);
