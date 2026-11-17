import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { clientGraphRecordsRegistration } from "./internal/client-graph-records";

export default {
  description:
    "Keeps an open tab's bundle served: touches the graph record (beside the served dist) of every build graph a tab's subscription or resource read names, at most hourly per graph, so address retention — a dev build's, or a release's launch — keeps that graph's addresses. In every served composition through the served-baseline row.",
  register: [clientGraphRecordsRegistration],
} satisfies MachinePluginDefinition;
