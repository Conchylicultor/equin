import { serveCollection } from "@plugins/network/plugins/live/server";
import { places, placeTags } from "../../core";
import { _places, _placeTags } from "./tables";

// Both collections are their tables whole (`all` sets): every field is a
// column by name, so the projection is exactly the row schema. The change feed
// routes each write — a save, a tag edit, a tag delete's re-tagging, the icon
// job's write — to the set: an entrant, an exit, or a one-row refill.
export const placesServed = serveCollection(places, { from: _places });

export const placeTagsServed = serveCollection(placeTags, {
  from: _placeTags,
});
