import type { ConversationRuntimeId } from "@plugins/conversations/plugins/runtime-catalog/core";
import { tasksRuntime } from "./tables";

/** The runtime the task picked, or null for the configured default. */
export async function getTaskRuntime(
  taskId: string,
): Promise<ConversationRuntimeId | null> {
  return (await tasksRuntime.get(taskId))?.runtime ?? null;
}

// Upsert the choice; `null` (the configured default) deletes the row.
export async function setTaskRuntime(
  taskId: string,
  runtime: ConversationRuntimeId | null,
): Promise<void> {
  if (runtime) await tasksRuntime.upsert(taskId, { runtime });
  else await tasksRuntime.delete(taskId);
}
