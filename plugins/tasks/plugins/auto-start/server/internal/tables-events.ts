import { defineTriggerEvent } from "@plugins/infra/plugins/events/server";

export interface TaskAutoStartArmedPayload {
  taskId: string;
  /** Why it was armed (the launcher's `cause`, for its logs). */
  cause: string;
  [key: string]: unknown;
}

// Emitted when a task is armed for auto-launch (`armTaskAutoStart`, after the
// marker is written). Whatever launches agents subscribes — the conversations
// plugin's launcher, the same way it subscribes to `tasks.statusChanged` — so
// the task plugins never name the launcher, and a host that runs none (an
// in-browser server) arms the task and wakes nothing. No filter columns:
// every subscriber matches every emit.
export const { event: taskAutoStartArmed, table: _taskAutoStartArmedTriggers } =
  defineTriggerEvent<TaskAutoStartArmedPayload>({
    name: "tasks.autoStartArmed",
    filters: {},
  });
