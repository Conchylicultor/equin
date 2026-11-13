import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { LiveColumns } from "@plugins/network/plugins/live/server";
import { conversationUsage } from "./internal/tables";
import {
  claudeAccountSpendServed,
  conversationUsageByIdServed,
} from "./internal/served";

export {
  _conversationUsageFiles,
  _conversationUsageExt,
} from "./internal/tables";

export default {
  description:
    "Per-conversation usage — cost, tokens and launched sub-agents — stored in conversations_ext_usage and exposed to every conversation list (LiveColumns.Expose) and read by id through the lookup-only conversations.usage collection; and what each Claude account spent per UTC day (conversation_usage_account_days), served as conversations.usage.account-spend. Counting it from the transcripts is the machine half's.",
  contributions: [
    // Cost / tokens / agents, folded into every list whose rows are
    // conversations.
    LiveColumns.Expose(conversationUsage),
    // One conversation's totals by id: the transcript's cost stat.
    ...conversationUsageByIdServed.declare,
    // What each Claude account spent per day: the agent manager's account foot.
    ...claudeAccountSpendServed.declare,
  ],
} satisfies ServerPluginDefinition;
