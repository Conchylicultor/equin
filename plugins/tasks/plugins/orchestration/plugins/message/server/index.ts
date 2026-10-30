import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { messageTreeCapability } from "./internal/capability";
import { listAgentsTool, messageAgentTool } from "./internal/tools";

export default {
  description:
    "Message the agents of a task tree, granted by message.tree: list_agents (every task of the caller's mandate tree an agent ran on, with its latest conversation and how it stands) and message_agent (an event turn typed into a task's latest conversation now — a working agent reads it at its next step — resuming it first when it stopped; refused outside the tree, to oneself, or where no agent ran). The capability's describe joins the Mandate section. Names no workflow.",
  contributions: [messageTreeCapability],
  register: [listAgentsTool, messageAgentTool],
} satisfies ServerPluginDefinition;
