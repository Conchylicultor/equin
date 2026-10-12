import {
  serveCollection,
  serveValue,
} from "@plugins/network/plugins/live/server";
import { places, placeSearch, placeTags } from "../../core";
import { searchPlaces } from "./places-repo";
import { _places, _placeTags } from "./tables";

// Both collections are their tables whole: every field is a column by name, so
// the projection is exactly the row schema. The change feed routes each write —
// a save, a tag edit, a tag delete's re-tagging, the icon job's write — to the
// windows holding the row.
export const placesServed = serveCollection(places, { from: _places });

export const placeTagsServed = serveCollection(placeTags, {
  from: _placeTags,
});

// Each question is one Google autocomplete call; nothing upstream signals a
// change, so the value is on-demand and re-asked only by a new question.
export const placeSearchServed = serveValue(placeSearch, {
  source: "external",
  changes: {
    fixed: {
      reason:
        "a Google Places autocomplete answer for one query: a third-party answer with no change signal",
    },
  },
  loader: ({ q, session }) => searchPlaces(q, session),
});
