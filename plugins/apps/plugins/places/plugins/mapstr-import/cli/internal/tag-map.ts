import type { MapstrTagKey } from "./mapstr-tree";

/**
 * Every Mapstr tag, mapped onto the tree the import seeds (`MAPSTR_TREE`) by its stable keys
 * (never by display name, which the user may rename). Mapstr's "A/B" tags land
 * on the child B alone; `.Done` / `.Todo` are the Been / Want to go role tags.
 * `drop` tags are not carried over. A tag missing here fails the import loudly:
 * it means the export holds a tag nobody decided about.
 */
export const MAPSTR_TAGS = {
  ".Done": "been",
  ".Todo": "want",
  "To Try": "drop",
  "Food/Bar": "bar",
  "Food/Fast-food": "fast-food",
  "Food/Restaurant": "restaurant",
  "Food/Snacks": "snacks",
  "Museum/Art": "art",
  "Museum/Autre": "museum-other",
  "Museum/History": "history",
  "Museum/Science": "science",
  Attraction: "attraction",
  Extérieur: "outdoors",
  // One tag whose name has slashes — not a Jeux › Shows › Events path.
  "Jeux/Shows/Events": "shows",
  Club: "club",
  Shop: "shop",
  Area: "area",
  Planifier: "plan",
  "40€": "price-40",
  "100+€": "price-100",
  "Permanently closed": "closed",
  Track: "track",
  Home: "home",
  Social: "social",
} as const satisfies Record<string, MapstrTagKey | "drop">;

function lookup(tag: string): MapstrTagKey | "drop" | undefined {
  const name = tag.normalize("NFC");
  return Object.hasOwn(MAPSTR_TAGS, name)
    ? MAPSTR_TAGS[name as keyof typeof MAPSTR_TAGS]
    : undefined;
}

/** The distinct Mapstr tags among `tags` that `MAPSTR_TAGS` does not know. */
export function unknownMapstrTags(tags: Iterable<string>): string[] {
  return [...new Set(tags)].filter((tag) => lookup(tag) === undefined).sort();
}

/** One place's Mapstr tags as Mapstr tree keys: deduped, dropped tags removed. */
export function mapMapstrTags(tags: readonly string[]): MapstrTagKey[] {
  const out = new Set<MapstrTagKey>();
  for (const tag of tags) {
    const key = lookup(tag);
    if (key === undefined) throw new Error(`Unknown Mapstr tag: "${tag}"`);
    if (key !== "drop") out.add(key);
  }
  return [...out];
}
