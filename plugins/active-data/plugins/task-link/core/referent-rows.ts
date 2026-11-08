import { liveCollection } from "@plugins/network/plugins/live/core";
import { tasksEntityRef } from "@plugins/tasks/plugins/tasks-core/core";

// What a `task-…` chip shows, by task id — lookup-only, a FOLLOW target: a
// live value showing stored text with its chips as their titles (a backlink's
// snippet) follows the tasks its text names (inline-chip's
// `followedReferent`). The row is exactly what `resolveTaskReferent` reads,
// so a write to any other task column (its status, `updated_at`) reaches no
// follower; a rename refills the row.
export const taskChipReferents = liveCollection("task-chip.referents", {
  from: tasksEntityRef,
  carry: { pick: ["id", "title"] },
  baseExposures: false,
  id: "id",
});
