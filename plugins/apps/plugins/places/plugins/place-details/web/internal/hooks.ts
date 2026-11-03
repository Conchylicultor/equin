import { useClockParam, useLive } from "@plugins/network/plugins/live/web";
import { MAPS_BILLING_MONTH } from "@plugins/integrations/plugins/google-maps/plugins/usage/core";
import type { ResourceResult } from "@plugins/network/plugins/live/plugins/live-state/web";
import { placeDetails, type PlaceDetailsResult } from "../../core";

/**
 * Google's rich details of a Google place, read while the caller is mounted;
 * `null` (a custom place: Google knows nothing of it) reads nothing.
 */
export function usePlaceDetails(
  googlePlaceId: string | null,
): ResourceResult<PlaceDetailsResult> {
  const month = useClockParam(MAPS_BILLING_MONTH);
  return useLive(
    placeDetails,
    googlePlaceId === null ? null : { googlePlaceId, month },
  );
}
