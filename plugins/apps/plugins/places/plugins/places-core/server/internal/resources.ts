import {
  serveCollection,
  serveValue,
} from "@plugins/network/plugins/live/server";
import { places, placeSearch, placeTags } from "../../core";
import { searchPlaces } from "./places-repo";
import { _places, _placeTags } from "./tables";

// Both collections are their tables whole (`all` sets): every field is a
// column by name, so the projection is exactly the row schema. The change feed
// routes each write — a save, a tag edit, a tag delete's re-tagging, the icon
// job's write — to the set: an entrant, an exit, or a one-row refill.
export const placesServed = serveCollection(places, { from: _places });

export const placeTagsServed = serveCollection(placeTags, {
  from: _placeTags,
});

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
