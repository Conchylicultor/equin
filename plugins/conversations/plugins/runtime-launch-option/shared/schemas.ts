import type { z } from "zod";
import { liveCollection } from "@plugins/network/plugins/live/core";
import { enumTextField } from "@plugins/fields/plugins/text/plugins/config/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";
import { CONVERSATION_RUNTIME_IDS } from "@plugins/conversations/plugins/runtime-catalog/core";

// One task's chosen runtime, stored in the `tasks_ext_runtime` entity-extension
// table (1:1 per task). No row = the configured default.
export const taskRuntimeShape = defineExtensionShape({
  key: "taskId",
  fields: {
    runtime: enumTextField(
      CONVERSATION_RUNTIME_IDS as [
        (typeof CONVERSATION_RUNTIME_IDS)[number],
        ...(typeof CONVERSATION_RUNTIME_IDS)[number][],
      ],
    ),
  },
  wireTimestamps: ["updatedAt"],
});
export type TaskRuntime = z.infer<typeof taskRuntimeShape.schema>;

// Lookup-only, like task-workspaces: every reader asks about ONE task (the
// launch option's picker reads and writes this row). `found: false` = the
// configured default.
export const taskRuntimes = liveCollection("task-runtimes", {
  from: taskRuntimeShape,
  id: "taskId",
});
