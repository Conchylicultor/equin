import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export default {
  description:
    "The sdk runtime's portable half: the conversations_ext_sdk_agent side table (each agent's event cursor and the projection of its events — session id, busy/idle, the open question, the last turn and its rewind anchor), the pure event reducer, and the mapping of a launch onto the agent's options file.",
} satisfies ServerPluginDefinition;
