import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { clientGraphRecordsRegistration } from "./internal/client-graph-records";

export default {
  description:
    "Keeps an open tab's bundle served: touches the graph record (beside the served dist) of every build graph a tab's subscription or resource read names, at most hourly per graph, so the build's address retention keeps that graph's addresses.",
  register: [clientGraphRecordsRegistration],
} satisfies MachinePluginDefinition;
