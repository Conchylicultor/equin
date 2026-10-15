import { getMapsKey } from "@plugins/integrations/plugins/google-maps/server";
import { PlacesApiError } from "@plugins/integrations/plugins/google-maps/plugins/places-api/core";
import { placeRichDetails } from "@plugins/integrations/plugins/google-maps/plugins/places-api/server";
import { Log } from "@plugins/primitives/plugins/log-channels/server";
import type { PlaceDetailsResult } from "../../core";
import { createTtlMemo, DETAILS_TTL_MS } from "./details-cache";

const log = Log.channel("places-details");

type Fetched = Exclude<PlaceDetailsResult, { kind: "maps-not-configured" }>;
const memo = createTtlMemo<Fetched>(DETAILS_TTL_MS);

/**
 * One place's rich details: Google's answer, reused for a day (one Enterprise
 * call per place per day, however often its card opens). Google refusing the
 * id (400 / 404: it no longer knows the place) is `unavailable`, kept the same
 * day; any other failure throws and is not kept. No key is not cached either —
 * setting one up takes effect at the next open.
 */
export async function loadPlaceDetails(
  googlePlaceId: string,
): Promise<PlaceDetailsResult> {
  const key = await getMapsKey();
  if (!key.ok) return { kind: "maps-not-configured" };
  return memo.get(googlePlaceId, async () => {
    log.publish(`fetch ${googlePlaceId}`);
    try {
      return {
        kind: "ok",
        details: await placeRichDetails(key.key, googlePlaceId),
      };
    } catch (err) {
      if (
        err instanceof PlacesApiError &&
        (err.status === 400 || err.status === 404)
      ) {
        return { kind: "unavailable", reason: err.message };
      }
      throw err;
    }
  });
}
