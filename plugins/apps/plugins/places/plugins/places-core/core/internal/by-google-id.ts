import type { Place } from "./schema";

/**
 * Every saved place that is a Google place, by its Google place id — how a
 * Google hit, a Sonnet pick or a page's place is recognised as one of yours.
 * A custom place (`googlePlaceId: null`) is in none of it. The one
 * construction of this lookup; never rebuild it inline.
 */
export function placesByGoogleId(
  places: readonly Place[],
): ReadonlyMap<string, Place> {
  return new Map(
    places.flatMap((p) =>
      p.googlePlaceId === null ? [] : [[p.googlePlaceId, p] as const],
    ),
  );
}
