import type { PlacesPicks } from "../../core";

/** The picked ids the run's searches never returned (an invented or misspelt id). */
export function unknownPicks(
  picks: PlacesPicks["picks"],
  known: ReadonlySet<string>,
): string[] {
  return picks.map((p) => p.googlePlaceId).filter((id) => !known.has(id));
}
