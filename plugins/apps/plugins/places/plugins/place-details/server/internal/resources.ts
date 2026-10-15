import { serveValue } from "@plugins/network/plugins/live/server";
import { placeDetails } from "../../core";
import { loadPlaceDetails } from "./details";

// One question per Google place; nothing upstream signals a change. The
// loader's own day-long memo bounds the Google calls, whatever the runtime
// re-asks.
export const placeDetailsServed = serveValue(placeDetails, {
  source: "external",
  changes: {
    fixed: {
      reason:
        "Google's rich details of one place: a third-party answer with no change signal, reused by the loader for a day",
    },
  },
  loader: ({ googlePlaceId }) => loadPlaceDetails(googlePlaceId),
});
