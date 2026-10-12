import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { idChip } from "@plugins/active-data/plugins/id-chip/web";
import { taskIdKind } from "@plugins/tasks/plugins/task-ids/core";
import { TASK_CHIP_SURFACES } from "../core";
import {
  TaskLinkChip,
  useTaskTarget,
  useTaskReferent,
} from "./components/task-link-chip";

export { TaskLinkChip };

export default {
  description:
    "Renders raw `task-<id>` strings inline as clickable chips that open the task detail pane, and presents the task id kind (title + open) to the id registry. Models emit the bare id, no tag wrapping needed.",
  contributions: [
    ...idChip({
      presenter: {
        kind: taskIdKind,
        useReferent: useTaskReferent,
        useTarget: useTaskTarget,
      },
      surfaces: TASK_CHIP_SURFACES,
      component: TaskLinkChip,
    }),
  ],
} satisfies PluginDefinition;
