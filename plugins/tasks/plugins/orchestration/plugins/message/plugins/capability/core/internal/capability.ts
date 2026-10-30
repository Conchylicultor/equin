import { z } from "zod";
import { defineCapability } from "@plugins/tasks/plugins/orchestration/plugins/mandate/plugins/policy/core";

/**
 * May see the agents working on the tasks of its mandate's tree
 * (`list_agents`) and send one of them a message (`message_agent`) — typed
 * into its conversation now, resuming it first when it stopped. `true` only —
 * no grant, no messaging.
 */
export const messageTree = defineCapability<true>({
  id: "message.tree",
  schema: z.literal(true),
  label: "Message the agents in its tree",
});
