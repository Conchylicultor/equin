import type { WatchEvent } from "@plugins/tasks/plugins/orchestration/plugins/watch/core";
import {
  endWatch,
  WatchHandler,
  watchTask,
} from "@plugins/tasks/plugins/orchestration/plugins/watch/server";
import { registeredAutomation } from "./registry";
import { releaseLaunchedTask } from "./release";
import { watchingAutomationId } from "./watch-owner";

const HANDLER = "automations.slot";
/** The report kinds that say the agent is done with what it was launched for. */
const REPORT_KINDS: ReadonlySet<string> = new Set(["reported", "asking"]);
/**
 * The facts after which the task holds no slot by its status
 * (`SLOT_SETTLED_STATUSES`): it settled, its agent ended without landing, or a
 * person held it. Each frees a slot without releasing it — a held or
 * attempted task that resumes takes its slot back.
 */
const SLOT_FREEING_KINDS: ReadonlySet<string> = new Set([
  "settled",
  "stopped",
  "held",
]);

/** A launched task holds its automation's slot until its agent reports or the
 * task stops: the automation watches the task in code, keyed by its id. */
export async function watchLaunchedTask(
  taskId: string,
  automationId: string,
): Promise<void> {
  await watchTask(taskId, {
    kind: "code",
    handler: HANDLER,
    key: automationId,
  });
}

/** What a batch means for the launched task's slot. Only the task's own
 * events count — a deeper task's report or settle is not this launch's. */
export function slotDecision(
  batch: readonly Pick<WatchEvent, "kind" | "taskId">[],
  taskId: string,
): "release" | "wake" | "none" {
  const own = batch.filter((e) => e.taskId === taskId);
  if (own.some((e) => REPORT_KINDS.has(e.kind))) return "release";
  if (own.some((e) => SLOT_FREEING_KINDS.has(e.kind))) return "wake";
  return "none";
}

/**
 * The launched task's own report frees its slot and ends the watch — later
 * events in its subtree go to whoever watches above. The task settling,
 * stopping or being held wakes the automation, whose run counts the slot free
 * from the task's status.
 */
export const slotWatchHandler = WatchHandler({
  id: HANDLER,
  async onEvents(batch, { watch, tx }) {
    const decision = slotDecision(batch, watch.taskId);
    if (decision === "release") {
      await releaseLaunchedTask(watch.taskId);
      await endWatch(watch.id, tx);
    } else if (decision === "wake") {
      registeredAutomation(watchingAutomationId(watch))?.wake();
    }
  },
});
