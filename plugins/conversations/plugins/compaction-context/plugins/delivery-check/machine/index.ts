import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { startDeliveryCheck, stopDeliveryCheck } from "./internal/check";
import { compactionContextCutKind } from "./internal/report-kind";

export default {
  description:
    "Reads back from the agent's transcript whether the context handed back after a compaction (compaction_context_sends) reached it whole — the first SessionStart context written since must hold the exact text — rather than trusting a copy of the Claude CLI's hook-output cap. When it did not, files compaction-context-cut and sends the whole context to the agent as a turn.",
  contributions: [compactionContextCutKind],
  onReady: startDeliveryCheck,
  onShutdown: stopDeliveryCheck,
} satisfies MachinePluginDefinition;
