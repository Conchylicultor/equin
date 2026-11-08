import { liveCollection } from "@plugins/network/plugins/live/core";
import {
  attemptsEntityRef,
  tasksEntityRef,
} from "@plugins/tasks/plugins/tasks-core/core";

// What an `att-…` chip shows, by attempt id — its task's title. Lookup-only,
// a FOLLOW target: a live value showing stored text with its chips as their
// titles (a backlink's snippet) follows the attempts its text names
// (inline-chip's `followedReferent`). The row is exactly what
// `resolveAttemptReferent` reads (the task joined on `task_id`), so only a
// rename of the attempt's task refills it.
export const attemptChipReferents = liveCollection("attempt-chip.referents", {
  from: attemptsEntityRef,
  carry: { pick: ["id"], fields: { taskTitle: tasksEntityRef.fields.title } },
  baseExposures: false,
  id: "id",
});
