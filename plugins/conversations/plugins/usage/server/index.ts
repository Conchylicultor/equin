import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { LiveColumns } from "@plugins/network/plugins/live/server";
import { conversationUsage } from "./internal/tables";

export {
  _conversationUsageFiles,
  _conversationUsageExt,
} from "./internal/tables";

export default {
  portable: true,
  description:
    "Per-conversation usage — cost, tokens and launched sub-agents — stored in conversations_ext_usage and exposed to every conversation list (LiveColumns.Expose). Counting it from the transcripts is the machine half's.",
  contributions: [
    // Cost / tokens / agents, folded into every list whose rows are
    // conversations.
    LiveColumns.Expose(conversationUsage),
  ],
} satisfies ServerPluginDefinition;
