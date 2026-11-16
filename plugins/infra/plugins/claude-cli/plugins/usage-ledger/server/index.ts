import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { _claudeUsageHours, _claudeUsageSources } from "./internal/tables";
export {
  negateUsage,
  usageLedgerDropSources,
  usageLedgerImport,
  usageLedgerRowsOf,
  usageLedgerUpsert,
  usageSourcesUpsert,
  type UsageLedgerRow,
  type UsageSourceRow,
} from "./internal/upsert";

export default {
  description:
    "The Claude usage ledger: claude_usage_hours (account, UTC hour, source — conv:<conversationId> | cli:<sourceName> | session:<claudeSessionId> — model, speed: tokens per kind split at the 200k tier, never dollars) with usageLedgerUpsert, the additive delta write (negative deltas take tokens back) its writers call inside the write that counted them, and claude_usage_sources (each source's project dir, repo flag, title). Its pricing child prices it as the claude_spend_hours_v view.",
} satisfies ServerPluginDefinition;
