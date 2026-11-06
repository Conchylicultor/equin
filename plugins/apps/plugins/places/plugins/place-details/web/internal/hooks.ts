import { useClockParam, useLive } from "@plugins/network/plugins/live/web";
import { MAPS_BILLING_MONTH } from "@plugins/integrations/plugins/google-maps/plugins/usage/core";
import type {
  ResourceResult,
  ResourceUnavailable,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import { placeDetails, type PlaceDetailsResult } from "../../core";

/**
 * Google's rich details of a Google place, read while the caller is mounted;
 * `null` (a custom place: Google knows nothing of it) reads nothing.
 * `unavailable` on a host without the computer (the demo): Google's details
 * are read with the computer's Places key.
 */
export function usePlaceDetails(
  googlePlaceId: string | null,
): ResourceResult<PlaceDetailsResult> | ResourceUnavailable {
  const month = useClockParam(MAPS_BILLING_MONTH);
  return useLive(
    placeDetails,
    googlePlaceId === null ? null : { googlePlaceId, month },
  );
}
