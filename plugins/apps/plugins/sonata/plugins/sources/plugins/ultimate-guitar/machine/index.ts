import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ugSearchServed } from "./internal/search-served";
import { ugTabServed } from "./internal/tab-served";

export { fetchUgTabContent } from "./internal/ug-client";

export default {
  description:
    "Ultimate Guitar source, desktop half (needsMachine: UG's private mobile API answers no browser): serves a tab URL's raw tab as the live sonata.ultimate-guitar.tab value (a bad URL or a missing tab refused, any other breakage loud) and the catalog search as sonata.ultimate-guitar.search.",
  contributions: [...ugSearchServed.declare, ...ugTabServed.declare],
} satisfies MachinePluginDefinition;
