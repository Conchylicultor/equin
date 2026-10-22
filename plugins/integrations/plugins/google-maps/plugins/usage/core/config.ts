import { defineConfig } from "@plugins/config_v2/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";

/**
 * How many calls of each billed Places SKU a month may make before a caller
 * that asks (`MapsBudget.withinBudget`) steps down to a cheaper
 * call. Each default is Google's free monthly allowance for that SKU minus a
 * margin — for the calls made with the same key outside this app, and for the
 * billing month being Pacific time. Google's IDs-only SKUs are free without a
 * cap and have no budget. Re-check Google's price list when it changes.
 *
 * The `name` is a load-bearing literal (persisted config); do not rename.
 */
export const mapsUsageConfig = defineConfig({
  name: "google-maps-usage",
  fields: {
    autocomplete: intField({
      default: 9500,
      min: 0,
      label: "Autocomplete requests / month",
      description: "Google's free allowance: 10,000.",
    }),
    placeDetailsEssentials: intField({
      default: 9500,
      min: 0,
      label: "Place Details Essentials / month",
      description: "Google's free allowance: 10,000.",
    }),
    placeDetailsPro: intField({
      default: 4800,
      min: 0,
      label: "Place Details Pro / month",
      description:
        "Google's free allowance: 5,000. Saving a place, the monthly refresh, the page place block.",
    }),
    placeDetailsEnterprise: intField({
      default: 950,
      min: 0,
      label: "Place Details Enterprise / month",
      description:
        "Google's free allowance: 1,000. A place card's rating, hours, price, phone and website; past it the card shows photos and its stored facts.",
    }),
    placeDetailsEnterpriseAtmosphere: intField({
      default: 950,
      min: 0,
      label: "Place Details Enterprise + Atmosphere / month",
      description:
        "Google's free allowance: 1,000. A place card's rich details with Google's summary; past it the card drops the summary.",
    }),
    textSearchPro: intField({
      default: 4800,
      min: 0,
      label: "Text Search Pro / month",
      description:
        "Google's free allowance: 5,000. The Places search without ratings, and the Mapstr import.",
    }),
    textSearchEnterprise: intField({
      default: 950,
      min: 0,
      label: "Text Search Enterprise / month",
      description:
        "Google's free allowance: 1,000. The Places search with ratings, prices and opening hours; past it the search drops them.",
    }),
    textSearchEnterpriseAtmosphere: intField({
      default: 950,
      min: 0,
      label: "Text Search Enterprise + Atmosphere / month",
      description: "Google's free allowance: 1,000.",
    }),
    placePhoto: intField({
      default: 950,
      min: 0,
      label: "Place Photos / month",
      description:
        "Google's free allowance: 1,000. Card photos and new gallery thumbnails; past it no new photo is fetched.",
    }),
  },
});
