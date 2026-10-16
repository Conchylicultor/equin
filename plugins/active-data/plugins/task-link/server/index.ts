import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { idChipServer } from "@plugins/active-data/plugins/id-chip/server";
import { _tasks } from "@plugins/tasks/plugins/tasks-core/server";
import { taskIdKind } from "@plugins/tasks/plugins/task-ids/core";
import { TASK_CHIP_SURFACES } from "../core";
import { resolveTaskReferent } from "./internal/referent";

export default {
  description:
    "The task id chip's server half (idChipServer): resolves a `task-<id>` to its task's title for the id registry and for model-read text, and registers the page-editor inline token so a page block holding the chip stays agent-readable.",
  contributions: [
    ...idChipServer({
      kind: taskIdKind,
      tables: [_tasks],
      surfaces: TASK_CHIP_SURFACES,
      resolve: resolveTaskReferent,
    }),
  ],
} satisfies ServerPluginDefinition;
