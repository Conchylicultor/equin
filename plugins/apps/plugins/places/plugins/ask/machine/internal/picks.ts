import type { PlacesPicks } from "../../core";

/** The picked ids the run's searches never returned (an invented or misspelt id). */
export function unknownPicks(
  picks: PlacesPicks["picks"],
  known: ReadonlySet<string>,
): string[] {
  return picks.map((p) => p.googlePlaceId).filter((id) => !known.has(id));
}

/**
 * The picked ids that came without an `about`. The schema leaves `about`
 * optional only so picks stored before it existed still parse; a new call
 * must carry it, so the tool refuses one that does not.
 */
export function picksWithoutAbout(picks: PlacesPicks["picks"]): string[] {
  return picks
    .filter((p) => p.about === undefined || p.about.trim() === "")
    .map((p) => p.googlePlaceId);
}
