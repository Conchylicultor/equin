import type { PlacesSku } from "@plugins/integrations/plugins/google-maps/plugins/places-api/core";

/** The rungs of the Places search's downgrade ladder (`PlaceSearchResult`). */
export const SEARCH_RUNGS = ["rich", "basic", "names"] as const;
export type SearchRung = (typeof SEARCH_RUNGS)[number];

/**
 * The downgrade ladder: Text Search with ratings (Enterprise) while its
 * monthly budget lasts, then without them (Pro), then autocomplete names —
 * so the search stays inside Google's free allowance.
 */
export function searchRung(
  withinBudget: (sku: PlacesSku) => boolean,
): SearchRung {
  if (withinBudget("text-search-enterprise")) return "rich";
  return withinBudget("text-search-pro") ? "basic" : "names";
}
