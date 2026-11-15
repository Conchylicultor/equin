import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { _claudeSpendHours } from "./internal/tables";
export { spendLedgerUpsert, type SpendLedgerRow } from "./internal/upsert";

export default {
  description:
    "The Claude spend ledger: claude_spend_hours (account, UTC hour, source — conv:<conversationId> | cli:<sourceName> | unattributed — cost at API prices) and spendLedgerUpsert, the accumulating write its two writers (the conversations usage sync, the claude-cli call recorder) add to it with, inside the write that counted the cost.",
} satisfies ServerPluginDefinition;
