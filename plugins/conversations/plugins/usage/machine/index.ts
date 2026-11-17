import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ExcludeFromChangeFeed } from "@plugins/network/plugins/live/plugins/change-feed/server";
import {
  _claudeTranscriptScans,
  _conversationUsageFiles,
} from "@plugins/conversations/plugins/usage/server";
import {
  usageBackfillJob,
  usageBackfillWarmup,
  usageHistoryImportJob,
  usageScanKeysJob,
  usageSessionBackfillJob,
  usageSessionSyncJob,
  usageSyncJob,
} from "./internal/jobs";
import { startLiveUsage, stopLiveUsage } from "./internal/live";
import { conversationCostAtServed } from "./internal/cost-at";

export default {
  description:
    "Claude usage, desktop-only half — the one reader of the transcripts on disk: each conversation's tokens counted incrementally (its resolved session chain plus every sub-agent) into the token ledger under conv:<conversationId>, with its agent count, by the sync and backfill jobs, the backfill warm-up and the live recount on every transcript append; every transcript no equin conversation owns, counted under its session:<sessionId> source (claude_transcript_scans: offset and tail per file), live on the host singleton and backfilled there; the one-shot history import of what came before the ledger (the conversations' earlier counts and the legacy cost archive's deleted transcripts); and what a conversation had cost by an instant (conversations.usage.cost-at: the priced ledger hours before it plus its own hour's stretch folded from the transcripts, sub-agents included).",
  register: [
    usageSyncJob,
    usageBackfillJob,
    usageSessionSyncJob,
    usageSessionBackfillJob,
    usageHistoryImportJob,
    usageScanKeysJob,
    usageBackfillWarmup,
  ],
  contributions: [
    // What the conversation had cost by an instant: the cost stat scrolled back.
    ...conversationCostAtServed.declare,
    ExcludeFromChangeFeed({
      table: _conversationUsageFiles,
      reason:
        "Scan state rewritten on every transcript append; no collection reads it — the lists read the totals in conversations_ext_usage.",
    }),
    ExcludeFromChangeFeed({
      table: _claudeTranscriptScans,
      reason:
        "Scan state (offset and tail) of the transcripts no conversation owns, rewritten on every append; no collection reads it — the counts are in claude_usage_hours.",
    }),
  ],
  onReady: () => {
    startLiveUsage();
  },
  onShutdown: () => {
    stopLiveUsage();
  },
} satisfies MachinePluginDefinition;
