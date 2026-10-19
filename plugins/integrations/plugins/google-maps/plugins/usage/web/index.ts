import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ConfigV2 } from "@plugins/config_v2/web";
import { mapsUsageConfig } from "../core";

export { useMapsBudget, type MapsBudget } from "./internal/use-maps-budget";

export default {
  description:
    "Registers the Google Maps usage budgets (per-SKU monthly call budgets inside Google's free allowance) for Settings → Config, and reads them against this month's live counts (useMapsBudget).",
  contributions: [ConfigV2.WebRegister({ descriptor: mapsUsageConfig })],
} satisfies PluginDefinition;
