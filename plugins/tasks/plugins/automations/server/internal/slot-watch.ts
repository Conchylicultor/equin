import {
  endWatch,
  WatchHandler,
  watchTask,
} from "@plugins/tasks/plugins/orchestration/plugins/watch/server";
import { releaseLaunchedTask } from "./release";

const HANDLER = "automations.slot";
/** The report kinds that say the agent is done with what it was launched for. */
const REPORT_KINDS: ReadonlySet<string> = new Set(["reported", "asking"]);

/** A launched task holds its automation's slot until its agent reports: the
 * automation watches the task in code, keyed by its id. */
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

/**
 * The launched task's own report frees its slot and ends the watch — later
 * events in its subtree go to whoever watches above. A report from deeper in
 * the subtree (a task its agent filed) is not this task's.
 */
export const slotWatchHandler = WatchHandler({
  id: HANDLER,
  async onEvents(batch, { watch, tx }) {
    const reported = batch.some(
      (e) => e.taskId === watch.taskId && REPORT_KINDS.has(e.kind),
    );
    if (!reported) return;
    await releaseLaunchedTask(watch.taskId);
    await endWatch(watch.id, tx);
  },
});
