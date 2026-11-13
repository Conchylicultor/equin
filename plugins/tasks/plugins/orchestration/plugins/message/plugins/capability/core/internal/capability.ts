import { z } from "zod";
import { defineCapability } from "@plugins/tasks/plugins/orchestration/plugins/mandate/plugins/policy/core";

/**
 * A supervisor's powers over the agents of its mandate's tree: see them
 * (`list_agents`) and reopen a closed one with a message (`message_agent`'s
 * `reopen`, on a task of the tree only). Messaging itself needs no grant —
 * every agent may message any other. `true` only.
 */
export const messageTree = defineCapability<true>({
  id: "message.tree",
  schema: z.literal(true),
  label: "See its tree's agents and reopen closed ones",
});
