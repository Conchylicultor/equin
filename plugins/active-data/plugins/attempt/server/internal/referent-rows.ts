import type { LookupJoin } from "@plugins/network/plugins/live/plugins/query-resource/core";
import { serveCollection } from "@plugins/network/plugins/live/server";
import { followedReferent } from "@plugins/primitives/plugins/text-editor/plugins/inline-chip/server";
import { _attempts, _tasks } from "@plugins/tasks/plugins/tasks-core/server";
import { attemptChipReferents } from "../../core";

/** The attempt's task — REQUIRED: `attempts.task_id` is a NOT NULL cascade FK. */
const taskJoin = {
  kind: "lookup",
  alias: "task",
  table: _tasks,
  pk: _tasks.id,
  on: { from: "base", col: _attempts.taskId },
  required: true,
} as const satisfies LookupJoin<"task", typeof _tasks>;

/** `attempt-chip.referents` over `attempts`, its task's title through the join. */
export const attemptChipReferentsServed = serveCollection(
  attemptChipReferents,
  {
    from: _attempts,
    joins: [taskJoin] as const,
    columns: { taskTitle: (j) => j.task.title },
  },
);

/** A live value's read of an `att-…` chip: the attempt's row, by the token itself. */
export const attemptChipLiveRead = followedReferent(
  attemptChipReferentsServed,
  {
    idOf: (token) => token,
    referentOf: (row) => ({ found: true, title: row.taskTitle }),
  },
);
