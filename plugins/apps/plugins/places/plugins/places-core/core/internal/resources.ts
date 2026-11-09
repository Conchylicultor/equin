import { liveCollection, liveValue } from "@plugins/network/plugins/live/core";
import {
  defineTagTree,
  TAG_TREE_MAX,
} from "@plugins/tag-tree/plugins/engine/core";
import { placesEntityRef, placeTagsEntityRef } from "./entity-refs";
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
  from: placesEntityRef,
  // The stored fields the Places DataView lists, in list order — their labels,
  // options and filter domains the entity's. The list adds the four it computes
  // from the tag tree (the name the app shows, Want to go, Been, Google link
  // lost); the rest of the row is carried.
  pick: ["address", "tags", "businessStatus", "location", "note", "createdAt"],
  carry: {
    pick: [
      "id",
      "googlePlaceId",
      "name",
      "title",
      "primaryType",
      "types",
      "mapsUrl",
      "googleLostAt",
      "icon",
      "autoTags",
      "fetchedAt",
      "updatedAt",
    ],
  },
  id: "id",
  all: {
    orderBy: [["createdAt", "desc"]],
    unbounded: {
      reason:
        "a person saves every place by hand, and the map draws every one of them",
      // Measured on main, 2026-11-08: 966.
      budget: 2000,
    },
  },
});

/**
 * The tag tree, live, as flat rows in rank order (`parentId` links them; the
 * tag-tree helpers walk it) — the WHOLE ordered set (`all`): every surface
 * reads the tree entire, and a tree cut at a window's edge orphans the
 * children of a tag past it — capped at the engine's `TAG_TREE_MAX`. The spec is the tag-tree spelling (pick the name
 * plus the listed extras, carry the rest) written out: the resource scanners
 * read a spec only as an inline object literal.
 *
 * The key is `places.tags.all`, not the old window's `places.tags` (see
 * `places`).
 */
export const placeTags = liveCollection("places.tags.all", {
  from: placeTagsEntityRef,
  // The name and the Google types are listed fields; the rest of the row
  // (the tree's links, colour, icon, rank, role) is carried.
  pick: ["name", "googleTypes"],
  carry: {
    pick: [
      "id",
      "parentId",
      "color",
      "childColors",
      "icon",
      "rank",
      "role",
      "createdAt",
      "updatedAt",
    ],
  },
  id: "id",
  all: {
    orderBy: [["rank", "asc"]],
    // A tag tree is read whole, so it is capped at the engine's bound
    // (the engine refuses a create past it).
    max: TAG_TREE_MAX,
  },
});

/**
 * The Places tag tree: the `:tree` id `places` of the tag-tree endpoints
 * (create, create path, update, move, delete) and what the shared picker reads.
 */
export const placeTagTree = defineTagTree({
  id: "places",
  entity: placeTagsEntityRef,
  collection: placeTags,
});

/**
 * The Google half of the Places search bar, as a typed-query value: one
 * question (`q`, the map box it is biased to, the round's session) is one
 * tuple. On-demand — an answer is a Google call nothing pushes a change to.
 * The answer names the rung of the downgrade ladder that gave it
 * (`PlaceSearchResult`); `maps-not-configured` renders `MapsAccessAction`.
 */
export const placeSearch = liveValue("places.search", {
  schema: PlaceSearchResultSchema,
  query: PlaceSearchQuerySchema,
  load: "on-demand",
  // Google's Places API, with the computer's Places key (auth/central).
  needsMachine: { feature: "Searching Google Places" },
});
