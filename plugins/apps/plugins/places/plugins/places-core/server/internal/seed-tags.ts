import type { TagRole } from "../../core";

// The tag tree a new Places install starts from: Status › Todo / Done (the
// role tags every place's status reads), then the everyday categories with
// their colours, Material Symbols icons and the Google place types that
// auto-tag a saved place. `key` is local to the seed — it wires `parent` —
// while each row's id is minted when seeded. Parents precede children; `rank`
// is the order among siblings, taken from the order here.

export interface SeedTag {
  key: string;
  role?: TagRole;
  name: string;
  icon: string;
  parent?: string;
  color?: string;
  googleTypes?: string[];
}

export const SEED_TAGS: readonly SeedTag[] = [
  { key: "status", role: "status", icon: "flag", name: "Status" },
  {
    key: "todo",
    role: "todo",
    icon: "bookmark",
    name: "Todo",
    parent: "status",
    color: "#94a3b8",
  },
  {
    key: "done",
    role: "done",
    icon: "check-circle",
    name: "Done",
    parent: "status",
    color: "#22c55e",
  },

  { key: "food", icon: "restaurant", name: "Food & drinks", color: "#f97316" },
  {
    key: "restaurants",
    icon: "restaurant-menu",
    name: "Restaurants",
    parent: "food",
    googleTypes: ["restaurant"],
  },
  {
    key: "french",
    icon: "bakery-dining",
    name: "French",
    parent: "restaurants",
    googleTypes: ["french_restaurant"],
  },
  {
    key: "italian",
    icon: "local-pizza",
    name: "Italian",
    parent: "restaurants",
    googleTypes: ["italian_restaurant", "pizza_restaurant"],
  },
  {
    key: "japanese",
    icon: "ramen-dining",
    name: "Japanese",
    parent: "restaurants",
    googleTypes: [
      "japanese_restaurant",
      "ramen_restaurant",
      "sushi_restaurant",
    ],
  },
  {
    key: "chinese",
    icon: "rice-bowl",
    name: "Chinese",
    parent: "restaurants",
    googleTypes: ["chinese_restaurant"],
  },
  {
    key: "vietnamese",
    icon: "soup-kitchen",
    name: "Vietnamese",
    parent: "restaurants",
    googleTypes: ["vietnamese_restaurant"],
  },
  {
    key: "coffee",
    icon: "local-cafe",
    name: "Coffee",
    parent: "food",
    googleTypes: ["cafe", "coffee_shop"],
  },
  {
    key: "bakeries",
    icon: "breakfast-dining",
    name: "Bakeries",
    parent: "food",
    googleTypes: ["bakery"],
  },
  { key: "bars", icon: "local-bar", name: "Bars", parent: "food" },
  {
    key: "wine",
    icon: "wine-bar",
    name: "Wine bars",
    parent: "bars",
    googleTypes: ["wine_bar"],
  },
  {
    key: "cocktails",
    icon: "nightlife",
    name: "Cocktails",
    parent: "bars",
    googleTypes: ["cocktail_bar", "bar"],
  },

  {
    key: "culture",
    icon: "account-balance",
    name: "Culture",
    color: "#3b82f6",
  },
  {
    key: "museums",
    icon: "museum",
    name: "Museums",
    parent: "culture",
    googleTypes: ["museum", "art_gallery"],
  },
  {
    key: "castles",
    icon: "castle",
    name: "Castles",
    parent: "culture",
    googleTypes: ["castle"],
  },
  {
    key: "temples",
    icon: "church",
    name: "Temples & churches",
    parent: "culture",
    googleTypes: ["church", "shinto_shrine", "buddhist_temple"],
  },
  { key: "streetart", icon: "brush", name: "Street art", parent: "culture" },
  {
    key: "music",
    icon: "music-note",
    name: "Live music",
    parent: "culture",
    googleTypes: ["live_music_venue", "jazz_club"],
  },

  { key: "nature", icon: "forest", name: "Nature", color: "#16a34a" },
  {
    key: "parks",
    icon: "park",
    name: "Parks",
    parent: "nature",
    googleTypes: ["park", "botanical_garden"],
  },
  {
    key: "hikes",
    icon: "hiking",
    name: "Hikes",
    parent: "nature",
    googleTypes: ["hiking_area"],
  },
  {
    key: "viewpoints",
    icon: "landscape",
    name: "Viewpoints",
    parent: "nature",
    googleTypes: ["observation_deck", "scenic_point"],
  },
  {
    key: "beaches",
    icon: "beach-access",
    name: "Beaches",
    parent: "nature",
    googleTypes: ["beach"],
  },

  { key: "shopping", icon: "shopping-bag", name: "Shopping", color: "#a16207" },
  {
    key: "books",
    icon: "menu-book",
    name: "Bookshops",
    parent: "shopping",
    googleTypes: ["book_store"],
  },
  {
    key: "markets",
    icon: "storefront",
    name: "Markets",
    parent: "shopping",
    googleTypes: ["market", "food_market"],
  },

  { key: "trips", icon: "flight", name: "Trips", color: "#a855f7" },
  {
    key: "japan27",
    icon: "travel-explore",
    name: "Japan 2027",
    parent: "trips",
  },
  { key: "italy", icon: "luggage", name: "Italy summer", parent: "trips" },
  {
    key: "loire",
    icon: "directions-car",
    name: "Loire weekend",
    parent: "trips",
  },

  { key: "kids", icon: "toys", name: "With kids", color: "#ec4899" },
  { key: "date", icon: "favorite", name: "Date night", color: "#e11d48" },

  { key: "recos", icon: "forum", name: "Recommended by", color: "#eab308" },
  { key: "alex", icon: "person", name: "Alex", parent: "recos" },
  { key: "marie", icon: "person", name: "Marie", parent: "recos" },
  { key: "nyt", icon: "newspaper", name: "NYT 36 Hours", parent: "recos" },
];
