import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { partialMessageServed } from "./internal/partial-message";

export default {
  description:
    "The conversations domain's desktop half: the conversations.partial-message live value — the text the agent is writing, held in memory while a page watches, from the conversation's runtime (watchPartial).",
  contributions: [...partialMessageServed.declare],
} satisfies MachinePluginDefinition;
