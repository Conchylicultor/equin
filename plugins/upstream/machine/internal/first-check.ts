import { db } from "@plugins/database/server";
import { defineWarmup } from "@plugins/infra/plugins/warmup/server";
import { _upstreamReleaseCheck } from "../../server/internal/tables";
import { detectUpstreamUpdatesJob } from "./detect-job";

/**
 * A clone that has never asked upstream asks it once, right after boot,
 * instead of waiting for the daily 05:00 UTC tick: until a check records an
 * answer the release status is `unknown` and the health report's updates row
 * is not drawn, so a fresh install would otherwise not hear of a release for
 * up to a day.
 *
 * One-shot by construction: it enqueues only while `upstream_release_check`
 * has no row, and the first answered check writes that row. An unreachable
 * upstream writes nothing, so the next boot asks again — as the daily job
 * does. `host` scope (main only), like the job's own schedule.
 */
export const firstUpstreamCheckWarmup = defineWarmup({
  name: "upstream.first-check",
  description:
    "Asks upstream for its newest release once after boot when this install has never checked, so the updates row appears without waiting for the daily check.",
  scope: "host",
  run: async () => {
    const [row] = await db
      .select({ checkedAt: _upstreamReleaseCheck.checkedAt })
      .from(_upstreamReleaseCheck)
      .limit(1);
    if (row !== undefined) return;
    await detectUpstreamUpdatesJob.enqueue({});
  },
});
