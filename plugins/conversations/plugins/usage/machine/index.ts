import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ExcludeFromChangeFeed } from "@plugins/database/plugins/change-feed/server";
import { _conversationUsageFiles } from "@plugins/conversations/plugins/usage/server";
import {
  usageBackfillJob,
  usageBackfillWarmup,
  usageRepriceJob,
  usageSyncJob,
} from "./internal/jobs";
import { startLiveUsage, stopLiveUsage } from "./internal/live";

export default {
  description:
    "Per-conversation usage, desktop-only half: counted incrementally from the transcripts on disk (the anchored session chain plus every sub-agent) — the sync, backfill and reprice jobs, the backfill warm-up and the live recount on every transcript append.",
  register: [
    usageSyncJob,
    usageBackfillJob,
    usageRepriceJob,
    usageBackfillWarmup,
  ],
  contributions: [
    ExcludeFromChangeFeed({
      table: _conversationUsageFiles,
      reason:
        "Scan state rewritten on every transcript append; no collection reads it — the lists read the totals in conversations_ext_usage.",
    }),
  ],
  onReady: () => {
    startLiveUsage();
  },
  onShutdown: () => {
    stopLiveUsage();
  },
} satisfies MachinePluginDefinition;
