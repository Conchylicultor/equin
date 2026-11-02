import { serveCollection } from "@plugins/network/plugins/live/server";
import { trackViews } from "../../shared/resources";
import { trackView } from "./tables";

/**
 * Serves `trackViews`, one scoped tuple per song, compiled from the table
 * (query-resource's `compileAllCollection`): the wire fields only (the
 * server-only timestamps are never fetched). The handlers notify nothing — the
 * change feed carries the write, routed by its `song_id`. `songId` leads the
 * primary key, so the scope read is an index range.
 */
export const trackViewsServed = serveCollection(trackViews, {
  from: trackView,
});
