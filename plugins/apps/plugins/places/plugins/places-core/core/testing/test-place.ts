import { placeIdKind, type Place } from "../index";

/**
 * A saved place for a test: a Google place named after its Google id, at
 * (0, 0), untagged — `over` sets whatever the test is about. Pass
 * `googlePlaceId: null` for a custom place.
 */
export function testPlace(over: Partial<Place> = {}): Place {
  const at = new Date("2026-01-01T00:00:00.000Z");
  const googlePlaceId =
    over.googlePlaceId === undefined ? "g-test" : over.googlePlaceId;
  return {
    id: placeIdKind.mint(),
    googlePlaceId,
    name: googlePlaceId ?? "Custom pin",
    title: null,
    address: "",
    location: { lat: 0, lng: 0 },
    primaryType: null,
    types: [],
    mapsUrl: null,
    businessStatus: null,
    googleLostAt: null,
    icon: null,
    note: "",
    tags: [],
    autoTags: [],
    fetchedAt: at,
    createdAt: at,
    updatedAt: at,
    ...over,
  };
}
