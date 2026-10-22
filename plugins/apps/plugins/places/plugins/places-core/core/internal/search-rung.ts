import type { PlacesSku } from "@plugins/integrations/plugins/google-maps/plugins/places-api/core";
import { budgetRung } from "@plugins/integrations/plugins/google-maps/plugins/usage/core";

/** The rungs of the Places search's downgrade ladder (`PlaceSearchResult`). */
export const SEARCH_RUNGS = ["rich", "basic", "names"] as const;
export type SearchRung = (typeof SEARCH_RUNGS)[number];

const SEARCH_LADDER = [
  { rung: "rich", sku: "text-search-enterprise" },
  { rung: "basic", sku: "text-search-pro" },
] as const;

/**
 * The downgrade ladder: Text Search with ratings (Enterprise) while its
 * monthly budget lasts, then without them (Pro), then autocomplete names —
 * so the search stays inside Google's free allowance.
 */
export function searchRung(
  withinBudget: (sku: PlacesSku) => boolean,
): SearchRung {
  return budgetRung<SearchRung>(SEARCH_LADDER, "names", withinBudget);
}
