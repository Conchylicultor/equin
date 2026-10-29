import type { WatchEvent } from "@plugins/tasks/plugins/orchestration/plugins/watch/core";
import {
  endWatch,
  WatchHandler,
  watchTask,
} from "@plugins/tasks/plugins/orchestration/plugins/watch/server";
import { registeredAutomation } from "./registry";
import { watchingAutomationId } from "./watch-owner";

const HANDLER = "automations.refire";

/** A file-kind automation declaring `watch: "refire"` watches each task it
 * files in code, keyed by its id. */
export async function watchFiledTask(
  taskId: string,
  automationId: string,
): Promise<void> {
  await watchTask(taskId, {
    kind: "code",
    handler: HANDLER,
    key: automationId,
  });
}

/** Whether the batch says the filed task itself settled. */
export function filingSettled(
  batch: readonly Pick<WatchEvent, "kind" | "taskId">[],
  taskId: string,
): boolean {
  return batch.some((e) => e.taskId === taskId && e.kind === "settled");
}

/**
 * The filed task settling (done or dropped) is what lets its automation file
 * again — it files nothing while its task is open — so the automation runs at
 * once rather than at its next event or schedule, and the watch ends. Events
 * from deeper in the subtree (tasks its agent filed) are not the filing's.
 */
export const refireWatchHandler = WatchHandler({
  id: HANDLER,
  async onEvents(batch, { watch, tx }) {
    if (!filingSettled(batch, watch.taskId)) return;
    await endWatch(watch.id, tx);
    registeredAutomation(watchingAutomationId(watch))?.wake();
  },
});
