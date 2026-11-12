import { defineConfig } from "@plugins/config_v2/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";

// Tunables for the per-client page-load judge, read live each tick. There is
// no fixed count: a tab's loads of one route in an hour are judged against how
// many times a client usually loads one route in an hour — a high quantile of
// every client-route-hour of the last 7 days — times `baselineFactor`.
export const clientRateConfig = defineConfig({
  name: "client-rate",
  fields: {
    enabled: boolField({
      default: true,
      label: "Enabled",
      description:
        "When off, the client-rate job returns early and files no client-rate reports.",
    }),
    baselineFactor: intField({
      default: 3,
      min: 2,
      max: 10,
      label: "Times the usual client hour",
      description:
        "File a client-rate report when one browser tab loads (or navigates to) the same route more than this many times what a client usually does in an hour (the 99th percentile of the last 7 days).",
    }),
  },
});
