import { z } from "zod";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { db } from "@plugins/database/server";
import { recomputeResource } from "@plugins/framework/plugins/server-core/core";
import { compactTargets } from "./persist";
import { l2Expectation } from "./expectation";
import { snapshotLog as log } from "./log-sink";

// Hourly L2 compaction. A persisted alias's scoped changes are written as FLOOR
// persists, which never raise a row's position (only a FULL replace does), and a
// legacy persisted key that nothing changes never re-persists at all. Catch-up
// and the changelog prune both read the GLOBAL min(position), so one such row
// would pin the floor — and the replay volume — forever. So every persisted key
// whose usable row was not REPLACED within the last hour (`position_at`; a
// missing, unusable or floor-only row counts too) is FULL-recomputed here: the
// recompute replaces its row with a fresh floor. It also bounds D22's staleness
// (a persisted value with no definition, after a loader change) to one hour.
//
// `recomputeResource` is in-process — it schedules the recompute in THIS
// backend's runtime, which is the one serving the persisted keys (a per-worktree
// job runs in its worktree's backend). `instant`: it only reads one indexed
// table and schedules notifies; the recomputes themselves run on the flush.
// Offset from the prune at `:00` so the prune sees the advanced floor next hour.
export const liveStateCompactJob = defineJob({
  name: "live-state-snapshot.compact",
  description:
    "Recomputes every saved live-state snapshot that has not been fully rewritten in the last hour, so the catch-up floor keeps moving forward.",
  hold: "instant",
  input: z.object({}),
  event: z.never(),
  dedup: "singleton",
  schedule: { cron: "30 * * * *", perWorktree: true },
  maxAttempts: 3,
  async run() {
    const targets = await compactTargets(db, l2Expectation());
    for (const key of targets) recomputeResource(key);
    if (targets.length > 0) {
      log.publish(
        `[live-state-snapshot] compact: recomputing ${targets.length} persisted key(s) not replaced in the last hour: ${targets.join(", ")}`,
      );
    }
  },
});
