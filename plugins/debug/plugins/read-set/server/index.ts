import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { resourcesDebugServed } from "./internal/resources-debug";

export default {
  description:
    "Serves resources.debug: the resource runtime's per-resource debug payload (policy, read-set, routes, relation reads, drift, subscribers, loader and notify counters, declared freshness) as one snapshot value every live-state debug pane reads.",
  contributions: [...resourcesDebugServed.declare],
} satisfies ServerPluginDefinition;
