import type { LatLng } from "@plugins/map/core";

/** What a link into Google Maps needs to know of a place, saved or not. */
export interface MapsLinkPlace {
  /** Null for a custom place: Google knows no place by its name. */
  googlePlaceId: string | null;
  name: string;
  address: string;
  location: LatLng;
  /** Google's own link to it, when stored. */
  mapsUrl?: string | null;
}

/**
 * Where "Open in Google Maps" goes: Google's own link for a Google place
 * (else a search pinned to its id), the pin's coordinates for a custom place.
 */
export function mapsHref(place: MapsLinkPlace): string {
  const search = "https://www.google.com/maps/search/?api=1";
  const { googlePlaceId } = place;
  if (googlePlaceId === null) {
    const { lat, lng } = place.location;
    return `${search}&query=${lat},${lng}`;
  }
  return (
    place.mapsUrl ??
    `${search}&query=${encodeURIComponent(
      `${place.name} ${place.address}`,
    )}&query_place_id=${encodeURIComponent(googlePlaceId)}`
  );
}

/**
 * Where Directions goes: Google Maps' route to the place, from wherever the
 * person is — pinned to its Google id when it has one.
 */
export function directionsHref(place: MapsLinkPlace): string {
  const { lat, lng } = place.location;
  const dir = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
  return place.googlePlaceId === null
    ? dir
    : `${dir}&destination_place_id=${encodeURIComponent(place.googlePlaceId)}`;
}
