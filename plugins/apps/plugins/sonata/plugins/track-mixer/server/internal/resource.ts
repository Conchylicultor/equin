import { eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { songIdKind } from "@plugins/apps/plugins/sonata/plugins/library/core";
import { serveValue } from "@plugins/network/plugins/live/server";
import { trackViews } from "../../shared/resources";
import { trackView } from "./tables";

/**
 * Serves `trackViews` per `{ songId }`: that song's rows, wire columns only (the
 * server-only timestamps are never fetched). The loader reads
 * `sonata_track_view` (declared in `reads`), so a write recomputes every
 * subscribed song — the handlers notify nothing. `songId` leads the primary key, so the
 * read is an index range.
 */
export const trackViewsServed = serveValue(trackViews, {
  source: "db",
  reads: {
    tables: [trackView.table],
    reason:
      "a write to any track view row may change its song's tuple; whole-table until it reads through a collection",
  },
  unbounded: {
    reason:
      "one song's per-track view overrides — at most one row per track of that song",
  },
  loader: ({ songId }) =>
    db
      .select(trackView.wireColumns)
      .from(trackView.table)
      .where(eq(trackView.table.songId, songIdKind.key(songId))),
});
