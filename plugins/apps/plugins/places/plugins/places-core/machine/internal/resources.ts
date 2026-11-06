import { serveValue } from "@plugins/network/plugins/live/machine";
import { placeSearch } from "../../core";
import { searchPlaces } from "./google-places";

// Each question is one Google search call; nothing upstream signals a change,
// so the value is on-demand and re-asked only by a new question.
export const placeSearchServed = serveValue(placeSearch, {
  source: "external",
  changes: {
    fixed: {
      reason:
        "a Google Places search answer for one query: a third-party answer with no change signal",
    },
  },
  loader: (query) => searchPlaces(query),
});
