import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { LiveColumns } from "@plugins/network/plugins/live/server";
import { DbTrigger } from "@plugins/database/plugins/db-triggers/server";
import { conversationUsage } from "./internal/tables";
import { usageCostTriggers, usageCostWarmup } from "./internal/cost-triggers";
import {
  claudeAccountSpendServed,
  conversationUsageByIdServed,
} from "./internal/served";

export {
  _claudeTranscriptScans,
  _conversationUsageFiles,
  _conversationUsageExt,
} from "./internal/tables";

export default {
  description:
    "Per-conversation usage — cost, tokens and launched sub-agents — stored in conversations_ext_usage (cost and tokens derived by database triggers from the priced token ledger, claude_spend_hours_v, for the conversation's conv: source; repaired by a warm-up once per change of that derivation) and exposed to every conversation list (LiveColumns.Expose) and read by id through the lookup-only conversations.usage collection; and what each Claude account spent per UTC day (the priced ledger's hours plus the carried-over legacy unattributed days, summed per day), served as conversations.usage.account-spend. Counting it from the transcripts is the machine half's.",
  contributions: [
    // Cost / tokens / agents, folded into every list whose rows are
    // conversations.
    LiveColumns.Expose(conversationUsage),
    // Cost and tokens derived from the token ledger, by the database itself.
    DbTrigger(usageCostTriggers),
    // One conversation's totals by id: the transcript's cost stat.
    ...conversationUsageByIdServed.declare,
    // What each Claude account spent per day: the agent manager's account foot.
    ...claudeAccountSpendServed.declare,
  ],
  register: [usageCostWarmup],
} satisfies ServerPluginDefinition;
