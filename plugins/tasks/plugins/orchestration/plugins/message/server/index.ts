import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { messageTreeCapability } from "./internal/capability";
import { listAgentsTool, messageAgentTool } from "./internal/tools";

export default {
  description:
    "Agents messaging agents: message_agent, visible to every agent (an event turn typed into the latest conversation of the task a task id or conversation id names, any task — a working agent reads it at its next step — resuming it first when it stopped; refused to oneself or where no agent ran; a closed one only with reopen, which needs the message.tree grant and a task of the caller's mandate tree), and list_agents, granted by message.tree (every task of the caller's mandate tree an agent ran on, with its latest conversation and how it stands). The capability's describe joins the Mandate section. Names no workflow.",
  contributions: [messageTreeCapability],
  register: [listAgentsTool, messageAgentTool],
} satisfies ServerPluginDefinition;
