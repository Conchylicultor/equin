import { sql, type SQL } from "drizzle-orm";
import { pgView, type AnyPgColumn } from "drizzle-orm/pg-core";
import { parsed } from "@plugins/database/plugins/sql-projection/server";
import { EVIDENCE_TTL_DAYS, VideoStatusSchema } from "../../core";
import { _chordVideos } from "./tables";

// Derived (plain) view. Lives in `views.ts` — NOT `tables.ts` — so the drizzle
// codegen glob never sees it: it is rebuilt from source on every boot via the
// `View` server contribution (declared in this plugin's server barrel) +
// rebuildDerivedViews, never tracked in the migration chain. To change it, edit
// here and `./equin build` — no migration is generated.
// See plugins/database/plugins/derived-views/CLAUDE.md.

const v = _chordVideos;

/** A source's status, or NULL once its observation is older than the TTL. */
function fresh(status: AnyPgColumn, checkedAt: AnyPgColumn): SQL {
  return sql`CASE WHEN ${checkedAt} > now() - make_interval(days => ${EVIDENCE_TTL_DAYS}) THEN ${status} END`;
}

const freshOembed = fresh(v.oembedStatus, v.oembedCheckedAt);
const freshPlayer = fresh(v.playerStatus, v.playerCheckedAt);

/**
 * One status per video that has a row, resolved from the two sources' fresh
 * evidence. A video with no row is `unknown` too: readers left-join this view
 * and treat a missing row the same way.
 *
 * - oEmbed `gone` wins outright: a video removed from YouTube is gone whoever
 *   played it last month.
 * - Otherwise the player wins. oEmbed is blind to region blocks and to videos
 *   that refuse playback on other sites, so a fresh oEmbed `ok` must not
 *   resurrect a video the player just failed on.
 * - Otherwise oEmbed's answer, and `unknown` when neither has a fresh one —
 *   which is what makes the next offer of that video check it again.
 */
export const chordVideoStatus = pgView("chord_video_status_v").as((qb) =>
  qb
    .select({
      videoId: v.videoId,
      status: sql`
        CASE
          WHEN ${freshOembed} = 'gone'      THEN 'gone'
          WHEN ${freshPlayer} IS NOT NULL   THEN ${freshPlayer}
          WHEN ${freshOembed} IS NOT NULL   THEN ${freshOembed}
          ELSE                                   'unknown'
        END
      `
        .mapWith(parsed(VideoStatusSchema, "chord_video_status_v.status"))
        .as("status"),
    })
    .from(v),
);
