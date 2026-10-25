import { eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { serveValue } from "@plugins/network/plugins/live/server";
import { _tasks } from "@plugins/tasks/plugins/tasks-core/server";
import { reviewTaskCounts, type ReviewTaskCounts } from "../../shared/schemas";
import { healthReviewExt } from "./tables";

async function loadReviewTaskCounts(
  reviewId: string,
): Promise<ReviewTaskCounts> {
  const rows = await db
    .select({ droppedAt: _tasks.droppedAt, heldAt: _tasks.heldAt })
    .from(healthReviewExt.table)
    .innerJoin(_tasks, eq(_tasks.id, healthReviewExt.table.taskId))
    .where(eq(healthReviewExt.table.reviewId, reviewId));
  const counts: ReviewTaskCounts = { open: 0, dropped: 0, held: 0 };
  // A dropped task counts as dropped even while it is also held.
  for (const r of rows) {
    if (r.droppedAt) counts.dropped++;
    else if (r.heldAt) counts.held++;
    else counts.open++;
  }
  return counts;
}

/**
 * One review's task counts. `db`: a task filed, dropped, held or resumed (a
 * `tasks` write) or a task linked to a review (the extension row) recomputes
 * every subscribed tuple. `tasks` is a hot table, hence the 1 s throttle.
 */
export const reviewTaskCountsServed = serveValue(reviewTaskCounts, {
  source: "db",
  reads: {
    tables: [healthReviewExt.table, _tasks],
    reason:
      "each tuple counts its review's linked tasks by their dropped / held columns; a write to any task or any review link may move any review's counts — whole-table until the link is read through a collection",
  },
  throttleMs: 1000,
  loader: ({ reviewId }) => loadReviewTaskCounts(reviewId),
});
