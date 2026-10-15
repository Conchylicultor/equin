import { useLive } from "@plugins/network/plugins/live/web";
import type { ResourceResult } from "@plugins/primitives/plugins/live-state/web";
import { placeDetails, type PlaceDetailsResult } from "../../core";

/**
 * Google's rich details of a Google place, read while the caller is mounted;
 * `null` (a custom place: Google knows nothing of it) reads nothing.
 */
export function usePlaceDetails(
  googlePlaceId: string | null,
): ResourceResult<PlaceDetailsResult> {
  return useLive(
    placeDetails,
    googlePlaceId === null ? null : { googlePlaceId },
  );
}
