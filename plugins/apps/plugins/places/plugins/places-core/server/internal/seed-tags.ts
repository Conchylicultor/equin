import type { ChildColorMode } from "@plugins/tag-tree/plugins/engine/core";
import type { TagRole } from "../../core";

// The tag tree a new Places install starts from: small and standard — the two
// role tags (Want to go, Been — independent, found by role), Favorites, a few
// broad categories with their colours, Material Symbols icons and the Google
// place types (Table A) that auto-tag a saved place, and a Price ramp. `key`
// is local to the seed — it wires `parent`, and names a seed tag to code that
// must not match a display name the user may rename — while each row's id is
// minted when seeded. Parents precede children; `rank` is the order among
// siblings, taken from the order here. A child with no colour inherits its
// parent's (Price shades its children instead: a ramp).
//
// A key is an identifier, not a name: it outlives a rename of its tag (the
// Café tag's key is `snacks`, Sights' `attraction`, Nature's `outdoors`), so
// code that names a seed tag by key (the promo film's seed) keeps working.
//
// Seeded only on an empty `place_tags` (`seedStarterPlaceTags`): changing it
// never touches an install that already has tags. A bulk import that brings
// its own categories brings its own tree (`replaceAllPlaces`' `tree`).

export interface SeedTag<K extends string = string> {
  key: K;
  role?: TagRole;
  name: string;
  icon: string;
  parent?: K;
  color?: string;
  childColors?: ChildColorMode;
  googleTypes?: readonly string[];
}

const SEED = [
  {
    key: "want",
    role: "want",
    icon: "bookmark",
    name: "Want to go",
    color: "#94a3b8",
  },
  {
    key: "been",
    role: "been",
    icon: "check-circle",
    name: "Been",
    color: "#22c55e",
  },
  { key: "favorite", icon: "favorite", name: "Favorites", color: "#e11d48" },

  { key: "food", icon: "restaurant", name: "Food", color: "#f97316" },
  {
    key: "restaurant",
    icon: "restaurant-menu",
    name: "Restaurant",
    parent: "food",
    googleTypes: ["restaurant"],
  },
  {
    key: "snacks",
    icon: "local-cafe",
    name: "Café",
    parent: "food",
    googleTypes: ["cafe", "coffee_shop", "bakery", "ice_cream_shop"],
  },
  {
    key: "bar",
    icon: "local-bar",
    name: "Bar",
    parent: "food",
    googleTypes: ["bar", "pub", "wine_bar"],
  },

  {
    key: "museum",
    icon: "museum",
    name: "Museum",
    color: "#3b82f6",
    googleTypes: ["museum"],
  },
  {
    key: "art",
    icon: "palette",
    name: "Art",
    parent: "museum",
    googleTypes: ["art_gallery", "art_museum"],
  },

  {
    key: "attraction",
    icon: "attractions",
    name: "Sights",
    color: "#14b8a6",
    googleTypes: ["tourist_attraction", "historical_landmark"],
  },
  {
    key: "outdoors",
    icon: "forest",
    name: "Nature",
    color: "#16a34a",
    googleTypes: ["park", "hiking_area", "national_park", "beach"],
  },
  {
    key: "shows",
    icon: "theater-comedy",
    name: "Nightlife & shows",
    color: "#6366f1",
    googleTypes: [
      "performing_arts_theater",
      "concert_hall",
      "movie_theater",
      "night_club",
    ],
  },
  {
    key: "shop",
    icon: "shopping-bag",
    name: "Shopping",
    color: "#a16207",
    googleTypes: ["store", "book_store", "shopping_mall"],
  },

  {
    key: "price",
    icon: "payments",
    name: "Price",
    color: "#eab308",
    childColors: "ramp",
  },
  { key: "price-1", icon: "euro-symbol", name: "€", parent: "price" },
  { key: "price-2", icon: "euro-symbol", name: "€€", parent: "price" },
  { key: "price-3", icon: "diamond", name: "€€€", parent: "price" },
] as const satisfies readonly SeedTag[];

export const SEED_TAGS: readonly SeedTag[] = SEED;

/**
 * A seed tag's stable key — how code outside the tree (the Mapstr import) names
 * a seed tag without matching its display name, which the user may rename.
 */
export type SeedTagKey = (typeof SEED)[number]["key"];
