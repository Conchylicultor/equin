import { StopWaiver } from "@plugins/conversations/plugins/stop-gate/server";
import { watchesOf } from "./queries";

/**
 * A watcher whose subtree still has work running may stop: the next event in
 * that subtree wakes it with a turn, so stopping is waiting, not walking away.
 */
export const watchStopWaiver = StopWaiver({
  id: "watch",
  async waives(conversationId) {
    const busy = (await watchesOf(conversationId)).filter((w) => !w.quiet);
    if (busy.length === 0) return null;
    const tasks = busy.map((w) => w.taskId).join(", ");
    return `You watch ${tasks}, where work is still running: you will be woken by the next event in that subtree.`;
  },
});
