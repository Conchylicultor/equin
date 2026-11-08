import { songIdKind } from "@plugins/apps/plugins/sonata/plugins/library/core";
import { compositeKey } from "@plugins/network/plugins/live/plugins/query-resource/core";
import { liveCollection } from "@plugins/network/plugins/live/core";
import { trackViewEntityRef } from "../core";

export type { TrackViewRow } from "../core";

/**
 * ONE song's persisted track-view overrides: a scoped whole set
 * (`all: { by: ["songId"] }`), one tuple per song, keyed by the table's
 * composite primary key `(songId, trackId)` — so a write to another song's
 * tracks reaches no tuple (the router skips it on the carried `song_id`), and
 * a write to this song's is a refill of the rows it touched, shipped as a
 * keyed delta. One song holds at most one row per track. The row fields live
 * in `core/` (single source of truth, shared with the server entity). Read by
 * the track-mixer's observer for the open song, which publishes it into the
 * shell's track-view store; its scope is also the send lane every track-view
 * write for that song departs on (`trackViewScope`).
 *
 * The key is NEW (`sonata-track-view.v2`; it was the param'd value
 * `sonata-track-view`): a tab still on a bundle that subscribed the old key
 * gets `unknown-key` — a `skew` verdict, the Reload prompt — instead of
 * parsing keyed deltas its value read cannot apply (C39). Pinned by
 * `../web/__tests__/track-views-old-tab.test.ts`.
 */
export const trackViews = liveCollection("sonata-track-view.v2", {
  from: trackViewEntityRef,
  carry: {
    pick: [
      "songId",
      "trackId",
      "color",
      "instrument",
      "muted",
      "hidden",
      "volume",
    ],
  },
  id: compositeKey(["songId", "trackId"]),
  all: {
    by: ["songId"],
    orderBy: [["trackId", "asc"]],
    unbounded: {
      reason:
        "one song's per-track view overrides — at most one row per track of that song",
      // Measured on main, 2026-11-08: 21 for the largest song.
      budget: 100,
    },
  },
});

/**
 * The scope of one song's track views — the read's and the send lane's alike.
 * The id is keyed (`songIdKind.key`) the way the write routes key it, so a
 * legacy bare-uuid song id reaches the rewritten rows.
 */
export function trackViewScope(songId: string): {
  where: { songId: string };
} {
  return { where: { songId: songIdKind.key(songId) } };
}
