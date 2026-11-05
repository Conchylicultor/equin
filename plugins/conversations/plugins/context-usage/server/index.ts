import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { conversationContextUsageServed } from "./internal/context-usage";

export { recordContextUsage } from "./internal/context-usage";

export default {
  description:
    "Each conversation's last context reading — what fills its agent's context window, as the harness measured it — in the conversations_ext_context_usage table: recordContextUsage, which a conversation runtime calls with each reading its agent reports, and the lookup-only conversations.context-usage collection the context ring reads. No read ever asks the agent.",
  contributions: [...conversationContextUsageServed.declare],
} satisfies ServerPluginDefinition;
