import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Item } from "@plugins/conversations/plugins/conversation-ui/plugins/item/web";
import { SupervisorDoneCountChip } from "./components/supervisor-done-count-chip";

export default {
  description:
    "Per-row done-count chip on a supervisor's conversation (its task states the supervisor mandate): how many tasks of the supervisor's tree are done, with a ring filled by the done share of the whole tree; hover for done / running / dropped.",
  contributions: [
    Item.Chips({
      id: "supervisor-done-count",
      component: SupervisorDoneCountChip,
    }),
  ],
} satisfies PluginDefinition;
