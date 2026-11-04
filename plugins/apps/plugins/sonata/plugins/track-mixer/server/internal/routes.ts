import { eq, sql } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { songIdKind } from "@plugins/apps/plugins/sonata/plugins/library/core";
import { implement } from "@plugins/infra/plugins/endpoints/server";
import { resetTrackView, upsertTrackView } from "../../shared/endpoints";
import { _trackView } from "./tables";

/**
 * Partial-patch upsert, one row per `trackIds` entry: insert a fresh row
 * (omitted fields take column defaults) or update only the provided columns of
 * an existing one. Lets a mute toggle land without clobbering a custom color and
 * vice-versa. Every track is written by ONE statement, so a many-track patch
 * is atomic and the change feed emits it as a single commit.
 */
export const handleUpsertTrackView = implement(
  upsertTrackView,
  async ({ params, body }) => {
    // No `updatedAt`: the DB trigger derives it from the counted columns. A
    // body with no field still needs a non-empty conflict `set` (drizzle rejects
    // an empty one), so the base is a no-op self-rewrite of the PK column — the
    // trigger sees no change, so it neither bumps nor raises.
    const set: Record<string, unknown> = {
      trackId: sql`excluded.track_id`,
    };
    if (body.color !== undefined) set.color = body.color;
    if (body.instrument !== undefined) set.instrument = body.instrument;
    if (body.muted !== undefined) set.muted = body.muted;
    if (body.hidden !== undefined) set.hidden = body.hidden;
    if (body.volume !== undefined) set.volume = body.volume;

    // ONE multi-row upsert: atomic, and no row stays locked across an app
    // round trip. Distinct ids, since one statement cannot touch a row twice.
    const songId = songIdKind.key(params.songId);
    await db
      .insert(_trackView)
      .values(
        [...new Set(body.trackIds)].map((trackId) => ({
          songId,
          trackId,
          color: body.color ?? null,
          instrument: body.instrument ?? null,
          muted: body.muted ?? false,
          hidden: body.hidden ?? false,
          volume: body.volume ?? 1,
        })),
      )
      .onConflictDoUpdate({
        target: [_trackView.songId, _trackView.trackId],
        set,
      });
  },
);

/** Drop every override for a song, restoring palette defaults + audible/visible. */
export const handleResetTrackView = implement(
  resetTrackView,
  async ({ params }) => {
    await db
      .delete(_trackView)
      .where(eq(_trackView.songId, songIdKind.key(params.songId)));
  },
);
