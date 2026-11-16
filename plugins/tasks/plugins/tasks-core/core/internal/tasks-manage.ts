import { z } from "zod";
import { defineCapability } from "@plugins/tasks/plugins/orchestration/plugins/mandate/plugins/policy/core";

/**
 * A supervisor's power over the tasks it owns (`edit_task`): arming /
 * disarming them and changing their track. Editing and dropping need no grant
 * beyond ownership — any agent that files tasks manages the ones it filed —
 * so this adds only what launches work. `true` only.
 */
export const tasksManage = defineCapability<true>({
  id: "tasks.manage",
  schema: z.literal(true),
  label: "Start and retrack the tasks it owns",
});
