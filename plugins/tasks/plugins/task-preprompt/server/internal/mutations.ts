import { resolvePrepromptItem } from "@plugins/conversations/plugins/preprompts/server";
import { tasksPreprompt } from "./tables";

export async function getTaskPreprompt(taskId: string) {
  return tasksPreprompt.get(taskId);
}

// Upsert when a preprompt id is given, delete when null. The live-state resource
// is invalidated by the DB change-feed so every surface (draft form, task
// detail) re-renders.
export async function setTaskPreprompt(
  taskId: string,
  prepromptId: string | null,
): Promise<void> {
  if (prepromptId) {
    await tasksPreprompt.upsert(taskId, { prepromptId });
  } else {
    await tasksPreprompt.delete(taskId);
  }
}

// Snapshot a source task's preprompt onto a destination task. Used when an agent
// spawns a subtask so it inherits the spawning agent's system prompt — only when
// that preprompt opts in (its `inherit` toggle, off by default). No-op when the
// source has no preprompt, or one that does not opt in, or one that no longer
// resolves (the subtask simply gets none).
export async function inheritTaskPreprompt(
  fromTaskId: string,
  toTaskId: string,
): Promise<void> {
  const source = await getTaskPreprompt(fromTaskId);
  if (!source) return;
  if (!resolvePrepromptItem(source.prepromptId)?.inherit) return;
  await setTaskPreprompt(toTaskId, source.prepromptId);
}
