import { fieldOverrides } from "@plugins/primitives/plugins/data-view/web";
import { conversationsActive } from "@plugins/tasks/plugins/tasks-core/core";

/**
 * The conversation fields, forced non-groupable so the gear's group-by picker
 * offers only `section` (and the exposed fields, a task's track) + `None`.
 */
export const QUEUE_OVERRIDES = fieldOverrides(conversationsActive, {
  title: { groupable: false },
  status: { groupable: false },
  model: { groupable: false },
  kind: { groupable: false },
  runtime: { groupable: false },
  createdAt: { groupable: false },
  updatedAt: { groupable: false },
  endedAt: { groupable: false },
  worktreePath: { groupable: false },
  taskTitle: { groupable: false },
});
