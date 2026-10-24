import { liveValue } from "@plugins/network/plugins/live/core";
import { wholeList } from "@plugins/packages/plugins/list-bound/core";
import { TrackViewRowSchema } from "../core";

export type { TrackViewRow } from "../core";

/**
 * ONE song's persisted track-view overrides — every `sonata_track_view` row of
 * `{ songId }`, pushed whole when any of them changes. A value, not a
 * collection: the table's key is the composite `(songId, trackId)`, so there is
 * no single id a `:rows` read could key on; one song holds at most one row per
 * track (the schema states that bound — `wholeList`). The row
 * schema + type live in `core/` (single source of truth, shared with the server
 * entity). Read by the track-mixer's observer for the open song, which
 * publishes it into the shell's track-view store; its `{ songId }` tuple is
 * also the send lane every track-view write for that song departs on.
 */
export const trackViews = liveValue("sonata-track-view", {
  schema: wholeList(TrackViewRowSchema, {
    reason:
      "one song's per-track view overrides — at most one row per track of that song",
  }),
  params: ["songId"],
});
