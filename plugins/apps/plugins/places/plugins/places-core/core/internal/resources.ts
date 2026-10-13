import { liveCollection, liveValue } from "@plugins/network/plugins/live/core";
import { PlaceSchema, PlaceTagSchema } from "./schema";
import { PlaceSearchQuerySchema, PlaceSearchResultSchema } from "./maps";

/**
 * The saved places, live, as the WHOLE ordered set (`all`, newest first) plus
 * its `:rows` point sibling (one place by id). A personal set — hundreds, a
 * few thousand at most — that the map draws whole and the tag sidebar counts
 * whole: a map that shows only the newest window of pins would lie about
 * where you have been. The Places DataView filters, sorts and searches it on
 * the client.
 *
 * The key is `places.places.all`, not the old window's `places.places`: no
 * bundle ever declared this key with another contract, so a tab on an older
 * one gets `unknown-key` (a `skew` verdict) and never parses these rows.
 */
export const places = liveCollection("places.places.all", {
  row: PlaceSchema,
  id: "id",
  all: {
    orderBy: [["createdAt", "desc"]],
    unbounded: {
      reason:
        "a person saves every place by hand, and the map draws every one of them",
    },
  },
});

/**
 * The tag tree, live, as flat rows in rank order (`parentId` links them;
 * `tagPath` / `tagDescendants` walk it) — the WHOLE ordered set (`all`): every
 * surface reads the tree entire, and a tree cut at a window's edge orphans the
 * children of a tag past it.
 *
 * The key is `places.tags.all`, not the old window's `places.tags` (see
 * `places`).
 */
export const placeTags = liveCollection("places.tags.all", {
  row: PlaceTagSchema,
  id: "id",
  all: {
    orderBy: [["rank", "asc"]],
    unbounded: {
      reason: "a person adds every tag by hand, and the tag tree is read whole",
    },
  },
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
