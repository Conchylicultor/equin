import { serveValue } from "@plugins/network/plugins/live/server";
import { mapsBudgetReads } from "@plugins/integrations/plugins/google-maps/plugins/usage/server";
import { placeDetails } from "../../core";
import { loadPlaceDetails } from "./details";

// One question per Google place; Google signals no change, so nothing calls
// `notify`. What moves an open card is this month's budget: every counted
// Places call recomputes it (`reads`), and the loader's day-long memo, keyed
// by (place, tier), answers again without a Google call unless the tier moved.
export const placeDetailsServed = serveValue(placeDetails, {
  source: "external",
  changes: "notified",
  reads: mapsBudgetReads,
  throttleMs: 1000,
  loader: ({ googlePlaceId }) => loadPlaceDetails(googlePlaceId),
});
