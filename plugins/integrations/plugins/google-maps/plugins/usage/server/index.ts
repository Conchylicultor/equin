import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2 } from "@plugins/config_v2/server";
import { mapsUsageConfig } from "../core";
import { mapsMonthUsageServed } from "./internal/resource";

export { mapsBudgetNow, mapsBudgetReads } from "./internal/resource";

export { _googleMapsUsage } from "./internal/tables";
export { placesMeter } from "./internal/ledger";

export default {
  description:
    "Owns google_maps_usage: every Places call counted per billing month (Pacific time, as Google bills) and SKU, by placesMeter — the meter every server-side PlacesClient carries — and served live as this month's counts (google-maps.usage), which a caller holds against the per-SKU budgets (the google-maps-usage config: Google's free allowance minus a margin) to step down to a cheaper call before it is billed; mapsBudgetNow is the same check read on the server (for a caller with no live value, an agent's tool).",
  contributions: [
    ConfigV2.Register({ descriptor: mapsUsageConfig }),
    ...mapsMonthUsageServed.declare,
  ],
} satisfies ServerPluginDefinition;
