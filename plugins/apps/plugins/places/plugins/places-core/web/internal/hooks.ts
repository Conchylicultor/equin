import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import {
  useLive,
  useLiveRow,
  type LiveRowResult,
} from "@plugins/network/plugins/live/web";
import type { ResourceResult } from "@plugins/primitives/plugins/live-state/web";
import {
  createPlaceTag,
  deletePlace,
  deletePlaceTag,
  places,
  placeTags,
  regeneratePlaceIcon,
  savePlace,
  placeSearch,
  updatePlace,
  updatePlaceTag,
  type Place,
  type PlaceTag,
  type PlaceSearchQuery,
} from "../../core";

/**
 * Every saved place, live: the whole set (newest first) — the map draws every
 * pin, and the surfaces filter on the client.
 */
export function usePlaces(): ResourceResult<Place[]> {
  return useLive(places);
}

/** One place by id, live: pending, then found or determinately absent. */
export function usePlaceRow(placeId: string): LiveRowResult<Place> {
  return useLiveRow(places, placeId);
}

/** The whole tag tree, live, as flat rows (rank order; `parentId` links them). */
export function usePlaceTags(): ResourceResult<PlaceTag[]> {
  return useLive(placeTags);
}

/**
 * Google Places autocomplete for `{ q, session }` (one session token per
 * search-to-pick round, passed again to the save). `null` reads nothing — pass
 * it while the debounced query is empty. The answer is a discriminated
 * `PlaceSearchResult`: `maps-not-configured` renders `MapsAccessAction`.
 */
export function usePlaceSearch(query: PlaceSearchQuery | null) {
  return useLive(placeSearch, query);
}

/**
 * Save a picked Google place. Branch on the result's `kind`: `saved`,
 * `already-saved` (nothing changed), or `maps-not-configured`.
 */
export function useSavePlace() {
  return useEndpointMutation(savePlace);
}

/** PATCH a place's note, tags (whole list) or status. */
export function useUpdatePlace() {
  return useEndpointMutation(updatePlace);
}

export function useDeletePlace() {
  return useEndpointMutation(deletePlace);
}

/** Re-pick the place's icon with Haiku now (pending for the call's lifetime). */
export function useRegeneratePlaceIcon() {
  return useEndpointMutation(regeneratePlaceIcon);
}

export function useCreatePlaceTag() {
  return useEndpointMutation(createPlaceTag);
}

export function useUpdatePlaceTag() {
  return useEndpointMutation(updatePlaceTag);
}

/** Delete a tag: its children and places move to its parent. */
export function useDeletePlaceTag() {
  return useEndpointMutation(deletePlaceTag);
}
