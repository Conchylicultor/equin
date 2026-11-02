import { z } from "zod";
import { defineCapability } from "@plugins/tasks/plugins/orchestration/plugins/mandate/plugins/policy/core";

/**
 * May edit (title, description, dependencies) and drop the tasks of its
 * mandate's tree (`edit_task`, `drop_task`) — never a task outside it, nor
 * the mandate's own root. `true` only — no grant, no tool.
 */
export const tasksManage = defineCapability<true>({
  id: "tasks.manage",
  schema: z.literal(true),
  label: "Edit and drop the tasks of its tree",
});
