import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  SupervisorDoneCount,
  useIsSupervisorConversation,
} from "./components/supervisor-done-count";

export default {
  description:
    "A supervisor's done count (SupervisorDoneCount): how many tasks of its tree are done, however deep, with a ring filled by the done share of the whole tree; hover for done / open / dropped. useIsSupervisorConversation(conv) tells whether a conversation is its supervisor's — running a task that states the supervisor mandate, not a side chat beside it (one stating its own mandate). The conversation progress chip draws it in place of its step bar on a supervisor's conversation.",
} satisfies PluginDefinition;
