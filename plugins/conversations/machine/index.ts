import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { contextUsageServed } from "./internal/context-usage";
import { partialMessageServed } from "./internal/partial-message";

export default {
  description:
    "The conversations domain's desktop half: the conversations.partial-message live value — the text the agent is writing, held in memory while a page watches, from the conversation's runtime (watchPartial) — and the conversations.context-usage live value, the agent's own measure of its context window (contextUsage), re-measured as its conversation row moves.",
  contributions: [
    ...partialMessageServed.declare,
    ...contextUsageServed.declare,
  ],
} satisfies MachinePluginDefinition;
