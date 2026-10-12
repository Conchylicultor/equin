import { liveCollection, liveValue } from "@plugins/network/plugins/live/core";
import {
  liveInstant,
  liveStringArray,
  liveText,
} from "@plugins/network/plugins/live/plugins/filter/core";
import { PlaceSchema, PlaceTagSchema } from "./schema";
import { PlaceSearchQuerySchema, PlaceSearchResultSchema } from "./maps";

/**
 * The saved places, live. A personal set — hundreds, a few thousand at most —
 * that the map draws whole, so the default window is large (2000, max 5000)
 * rather than a page: a map that shows only the newest page of pins would lie
 * about where you have been. `tags` is filterable (the tag sidebar's
 * include / exclude rules), as are the name and Google id.
 */
export const places = liveCollection("places.places", {
  row: PlaceSchema,
  id: "id",
  filterable: {
    name: liveText(),
    googlePlaceId: liveText(),
    tags: liveStringArray(),
    autoTags: liveStringArray(),
    createdAt: liveInstant(),
    updatedAt: liveInstant(),
  },
  sortable: ["createdAt", "updatedAt", "name"],
  default: { orderBy: [["createdAt", "desc"]], limit: 2000 },
  maxLimit: 5000,
});

/**
 * The tag tree, live, as flat rows (`parentId` links them; `tagPath` /
 * `tagDescendants` walk it). Read whole by every surface — the tree is tens of
 * tags — under the same generous bound as the places.
 */
export const placeTags = liveCollection("places.tags", {
  row: PlaceTagSchema,
  id: "id",
  filterable: {
    name: liveText(),
  },
  sortable: ["rank", "name", "createdAt"],
  default: { orderBy: [["rank", "asc"]], limit: 2000 },
  maxLimit: 5000,
});

/**
 * Google Places autocomplete for the Add place search, as a typed-query value:
 * one question (`q` + the search's session token) is one tuple. On-demand — an
 * answer is a Google call nothing pushes a change to. `maps-not-configured`
 * renders `MapsAccessAction`.
 */
export const placeSearch = liveValue("places.search", {
  schema: PlaceSearchResultSchema,
  query: PlaceSearchQuerySchema,
  load: "on-demand",
});
