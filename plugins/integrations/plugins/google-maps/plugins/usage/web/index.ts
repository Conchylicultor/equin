import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ConfigV2 } from "@plugins/config_v2/web";
import { Auth } from "@plugins/auth/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { mapsUsageConfig } from "../core";
import { UsageReadout } from "./components/usage-readout";
import { useUsageStatus } from "./internal/use-usage-rows";

export { useMapsBudget } from "./internal/use-maps-budget";

export default {
  description:
    "Registers the Google Maps usage budgets (per-SKU monthly call budgets inside Google's free allowance) for Settings → Config, and reads them against this month's live counts (useMapsBudget). Contributes the Google Maps 'Usage this month' row of Settings → Accounts: every billed Places SKU's calls against its budget, live, with the month's reset and a link to edit the budgets.",
  contributions: [
    ConfigV2.WebRegister({ descriptor: mapsUsageConfig }),
    Auth.Integration({
      id: "google-maps-usage",
      name: "Usage this month",
      icon: symbol("speed"),
      service: "Google Maps",
      description:
        "Places calls against Google's free monthly allowance; past a budget, calls step down instead of being billed.",
      setup: UsageReadout,
      useStatus: useUsageStatus,
    }),
  ],
} satisfies PluginDefinition;
