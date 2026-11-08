import { serveCollection } from "@plugins/network/plugins/live/server";
import { followedReferent } from "@plugins/primitives/plugins/text-editor/plugins/inline-chip/server";
import { _tasks } from "@plugins/tasks/plugins/tasks-core/server";
import { taskChipReferents } from "../../core";

/** `task-chip.referents` over the `tasks` table: its `id` and `title` columns. */
export const taskChipReferentsServed = serveCollection(taskChipReferents, {
  from: _tasks,
});

/** A live value's read of a `task-…` chip: the task's row, by the token itself. */
export const taskChipLiveRead = followedReferent(taskChipReferentsServed, {
  idOf: (token) => token,
  referentOf: (row) => ({ found: true, title: row.title }),
});
