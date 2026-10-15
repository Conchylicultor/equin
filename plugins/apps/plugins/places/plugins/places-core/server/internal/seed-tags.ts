import type { ChildColorMode, TagRole } from "../../core";

// The tag tree a new Places install starts from: the two role tags (Want to
// go, Been — independent, found by role), then the categories with their
// colours, Material Symbols icons and the Google place types (Table A) that
// auto-tag a saved place. `key` is local to the seed — it wires `parent` —
// while each row's id is minted when seeded. Parents precede children; `rank`
// is the order among siblings, taken from the order here. A child with no
// colour inherits its parent's (Price shades its children instead: a ramp).

export interface SeedTag {
  key: string;
  role?: TagRole;
  name: string;
  icon: string;
  parent?: string;
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

  { key: "food", icon: "restaurant", name: "Food", color: "#f97316" },
  {
    key: "restaurant",
    icon: "restaurant-menu",
    name: "Restaurant",
    parent: "food",
    googleTypes: ["restaurant"],
  },
  {
    key: "bar",
    icon: "local-bar",
    name: "Bar",
    parent: "food",
    googleTypes: ["bar", "pub", "wine_bar"],
  },
  {
    key: "fast-food",
    icon: "fastfood",
    name: "Fast-food",
    parent: "food",
    googleTypes: ["fast_food_restaurant"],
  },
  {
    key: "snacks",
    icon: "local-cafe",
    name: "Snacks",
    parent: "food",
    googleTypes: ["cafe", "coffee_shop", "bakery", "ice_cream_shop"],
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
    key: "history",
    icon: "history-edu",
    name: "History",
    parent: "museum",
    googleTypes: ["history_museum"],
  },
  { key: "science", icon: "science", name: "Science", parent: "museum" },
  { key: "museum-other", icon: "category", name: "Autre", parent: "museum" },

  {
    key: "attraction",
    icon: "attractions",
    name: "Attraction",
    color: "#14b8a6",
    googleTypes: ["tourist_attraction", "amusement_park"],
  },
  {
    key: "outdoors",
    icon: "forest",
    name: "Extérieur",
    color: "#16a34a",
    googleTypes: ["park", "hiking_area", "national_park", "beach"],
  },
  {
    key: "shows",
    icon: "theater-comedy",
    name: "Jeux/Shows/Events",
    color: "#6366f1",
    googleTypes: [
      "performing_arts_theater",
      "concert_hall",
      "movie_theater",
      "bowling_alley",
    ],
  },
  {
    key: "club",
    icon: "nightlife",
    name: "Club",
    color: "#ec4899",
    googleTypes: ["night_club"],
  },
  {
    key: "shop",
    icon: "shopping-bag",
    name: "Shop",
    color: "#a16207",
    googleTypes: ["store", "book_store", "shopping_mall"],
  },
  { key: "area", icon: "explore", name: "Area", color: "#84cc16" },
  { key: "plan", icon: "event", name: "Planifier", color: "#a855f7" },

  {
    key: "price",
    icon: "payments",
    name: "Price",
    color: "#eab308",
    childColors: "ramp",
  },
  { key: "price-40", icon: "euro-symbol", name: "40€", parent: "price" },
  { key: "price-100", icon: "diamond", name: "100+€", parent: "price" },

  {
    key: "closed",
    icon: "block",
    name: "Permanently closed",
    color: "#78716c",
  },
  { key: "track", icon: "directions-run", name: "Track", color: "#1e293b" },
  { key: "home", icon: "home", name: "Home", color: "#e11d48" },
  { key: "social", icon: "groups", name: "Social", color: "#0ea5e9" },
] as const satisfies readonly SeedTag[];

export const SEED_TAGS: readonly SeedTag[] = SEED;

/**
 * A seed tag's stable key — how code outside the tree (the Mapstr import) names
 * a seed tag without matching its display name, which the user may rename.
 */
export type SeedTagKey = (typeof SEED)[number]["key"];
