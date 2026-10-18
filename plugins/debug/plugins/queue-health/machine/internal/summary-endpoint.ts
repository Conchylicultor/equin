import { implementMachine } from "@plugins/infra/plugins/endpoints/machine";
import {
  queryQueueBacklog,
  queryBacklogByJobName,
  queryRunningJobs,
  queryDeadJobStats,
} from "@plugins/infra/plugins/jobs/machine";
import {
  reachableSlots,
  TOTAL_JOB_SLOTS,
} from "@plugins/infra/plugins/jobs/core";
import { queueHealthSummaryEndpoint } from "../../core";

// A single attributed snapshot of this worktree's queue health, assembled from
// the jobs plugin's read-only introspection API (which owns the graphile
// coupling) plus the ladder's own slot counts. The MCP tool proxies to this route
// through the gateway so it always reads the target worktree's live backend.
//
// `concurrency` + `backlog` stay the all-classes rollup, byte-identical to what
// they meant before hold classes existed. `classes` adds the per-tier view: the
// same depth numbers, each paired with `reachableSlots(hold)` — how many of the
// pool's slots that class can ever be picked up by. Both come from the SAME
// `queryQueueBacklog()` result, which sums its per-class rows into the rollup, so
// the two views cannot disagree.
export const handleQueueHealthSummary = implementMachine(
  queueHealthSummaryEndpoint,
  async () => {
    const [backlog, byJobName, running, dead] = await Promise.all([
      queryQueueBacklog(),
      queryBacklogByJobName(),
      queryRunningJobs(),
      queryDeadJobStats(),
    ]);
    return {
      concurrency: TOTAL_JOB_SLOTS,
      backlog: {
        readyCount: backlog.readyCount,
        lockedCount: backlog.lockedCount,
        oldestOverdueMs: backlog.oldestOverdueMs,
      },
      classes: backlog.classes.map((c) => ({
        hold: c.hold,
        reachableSlots: reachableSlots(c.hold),
        readyCount: c.readyCount,
        lockedCount: c.lockedCount,
        oldestOverdueMs: c.oldestOverdueMs,
      })),
      byJobName,
      running,
      dead,
    };
  },
);
