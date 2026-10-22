import { getPlacesClient } from "@plugins/integrations/plugins/google-maps/server";
import {
  PlacesApiError,
  type PlaceRichDetails,
  type RichDetailsTier,
} from "@plugins/integrations/plugins/google-maps/plugins/places-api/core";
import { placeRichDetails } from "@plugins/integrations/plugins/google-maps/plugins/places-api/server";
import { mapsBudgetNow } from "@plugins/integrations/plugins/google-maps/plugins/usage/server";
import { Log } from "@plugins/primitives/plugins/log-channels/server";
import { detailsTier, type PlaceDetailsResult } from "../../core";
import { createTtlMemo, DETAILS_TTL_MS } from "./details-cache";

const log = Log.channel("places-details");

/** Google's answer at one tier, as kept for the day. */
type Fetched =
  | { kind: "ok"; details: PlaceRichDetails; tier: RichDetailsTier }
  | { kind: "unavailable"; reason: string };
const memo = createTtlMemo<Fetched>(DETAILS_TTL_MS);

/**
 * One place's rich details at the richest tier this month's budget allows
 * (`detailsTier`): Google's answer, reused for a day per (place, tier) — so a
 * thinner answer fetched once a budget ran out is not served past the turn of
 * the month. Google refusing the id (400 / 404: it no longer knows the place)
 * is `unavailable`, kept the same day; any other failure throws and is not
 * kept. No key is not cached either — setting one up takes effect at the next
 * open. The Place Photo budget is read at every answer, so a kept answer drops
 * its photos the moment that budget is spent.
 */
export async function loadPlaceDetails(
  googlePlaceId: string,
): Promise<PlaceDetailsResult> {
  const maps = await getPlacesClient();
  if (!maps.ok) return { kind: "maps-not-configured" };
  const budget = await mapsBudgetNow();
  const tier = detailsTier(budget.withinBudget);
  const fetched = await memo.get(`${tier}:${googlePlaceId}`, async () => {
    log.publish(`fetch ${googlePlaceId} (${tier})`);
    try {
      return {
        kind: "ok",
        details: await placeRichDetails(maps.client, googlePlaceId, tier),
        tier,
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
  if (fetched.kind === "unavailable") return fetched;
  const photosPaused = !budget.withinBudget("place-photo");
  return {
    ...fetched,
    details: photosPaused
      ? { ...fetched.details, photos: [] }
      : fetched.details,
    photosPaused,
    ...(tier !== "full" || photosPaused ? { resumesAt: budget.resetsAt } : {}),
  };
}
