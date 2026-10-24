import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import {
  useLive,
  useLiveRow,
  type LiveRowResult,
} from "@plugins/network/plugins/live/web";
import type { ResourceResult } from "@plugins/primitives/plugins/live-state/web";
import { useTagTree } from "@plugins/tag-tree/plugins/engine/web";
import {
  createCustomPlace,
  deletePlace,
  places,
  placeTagTree,
  regeneratePlaceIcon,
  savePlace,
  placeSearch,
  updatePlace,
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

/**
 * The whole tag tree, live, as flat rows (rank order; `parentId` links them).
 * Its writes are `useTagTreeActions(placeTagTree)` (the tag-tree engine).
 */
export function usePlaceTags(): ResourceResult<PlaceTag[]> {
  return useTagTree(placeTagTree);
}

/**
 * The Google half of the Places search for `{ q, bias, session }` (the map box
 * the search is biased to; one session token per search round, passed again
 * to a save from a `names` answer). `null` reads nothing — pass it while the
 * debounced query is too short. The answer is a discriminated
 * `PlaceSearchResult` naming its rung of the downgrade ladder;
 * `maps-not-configured` renders `MapsAccessAction`.
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

/** Drop a custom place (a named pin, no Google place behind it); its icon follows. */
export function useCreateCustomPlace() {
  return useEndpointMutation(createCustomPlace);
}

/**
 * PATCH a place: its title (a custom place's name), a custom place's pin
 * position, its note or its tags (the whole list — Been / Want to go included).
 */
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
