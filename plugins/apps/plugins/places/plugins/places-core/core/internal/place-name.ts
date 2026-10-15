import type { Place } from "./schema";

/**
 * The name the app shows for a place — on its pin, its card, in the gallery,
 * the list, search and sort: the user's title when set, else `name` (Google's,
 * or a custom place's own). The one derivation; never read `title ?? name`
 * anywhere else.
 */
export function placeName(place: Pick<Place, "title" | "name">): string {
  return place.title ?? place.name;
}

/** A custom place: a pin the user dropped, with no Google place behind it. */
export function isCustomPlace<P extends Pick<Place, "googlePlaceId">>(
  place: P,
): place is P & { googlePlaceId: null } {
  return place.googlePlaceId === null;
}
