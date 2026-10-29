import { Mandate } from "@plugins/tasks/plugins/orchestration/plugins/mandate/server";
import { StopWaiver } from "@plugins/conversations/plugins/stop-gate/server";
import { contextCompact } from "@plugins/conversations/plugins/self-compact/plugins/capability/core";
import { hasPendingCompaction } from "./compaction";

export const contextCompactCapability = Mandate.Capability({
  cap: contextCompact,
  describe: () =>
    "You may compact your own context with `compact_context` after a major step: say what to keep and what to do next, then end your turn.",
});

/**
 * An agent that asked to be compacted may stop: the compaction and its
 * continuation are sent the moment its turn ends, so stopping is the step it
 * asked for — not walking away from work a gate still requires.
 */
export const compactionStopWaiver = StopWaiver({
  id: "self-compact",
  async waives(conversationId) {
    return (await hasPendingCompaction(conversationId))
      ? "You asked to compact your context: it runs now, and you continue with what you said next."
      : null;
  },
});
