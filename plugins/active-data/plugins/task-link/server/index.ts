import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { idChipServer } from "@plugins/active-data/plugins/id-chip/server";
import { taskIdKind } from "@plugins/tasks/plugins/task-ids/core";
import { TASK_CHIP_SURFACES } from "../core";
import {
  taskChipLiveRead,
  taskChipReferentsServed,
} from "./internal/referent-rows";
import { resolveTaskReferent } from "./internal/referent";

export default {
  description:
    "The task id chip's server half (idChipServer): resolves a `task-<id>` to its task's title for the id registry and for model-read text, and registers the page-editor inline token so a page block holding the chip stays agent-readable.",
  contributions: [
    // The chip's referent rows, by id — what a live value showing stored
    // text with its chips as titles follows (`taskChipLiveRead`).
    ...taskChipReferentsServed.declare,
    ...idChipServer({
      kind: taskIdKind,
      live: taskChipLiveRead,
      surfaces: TASK_CHIP_SURFACES,
      resolve: resolveTaskReferent,
    }),
  ],
} satisfies ServerPluginDefinition;
