import type { JsonlEvent } from "./protocol";

/** The tool an agent stops a background task with (`{ task_id }`). */
const TASK_STOP_TOOL_NAME = "TaskStop";

/**
 * When each background task was stopped by a successful `TaskStop` call — the
 * time of its result, keyed by the stopped `task_id`. First wins: a task stops
 * once.
 *
 * Claude Code writes NO `task-notification` for a background task the agent
 * stopped itself (a shell, a workflow run), so this is the only record that it
 * ended: without it, the task reads as running for as long as the
 * conversation lives.
 */
export function taskStopTimes(
  events: readonly JsonlEvent[],
): Map<string, Date> {
  const stops = new Map<string, Date>();
  for (const event of events) {
    if (event.kind !== "tool-call" || event.name !== TASK_STOP_TOOL_NAME) {
      continue;
    }
    if (event.result === undefined || event.result.isError === true) continue;
    const input = event.input;
    if (typeof input !== "object" || input === null) continue;
    const taskId = (input as Record<string, unknown>).task_id;
    if (typeof taskId !== "string" || stops.has(taskId)) continue;
    stops.set(taskId, new Date(event.result.at));
  }
  return stops;
}
