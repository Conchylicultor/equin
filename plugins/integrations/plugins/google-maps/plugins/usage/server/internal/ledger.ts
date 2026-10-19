import { sql } from "drizzle-orm";
import { db } from "@plugins/database/server";
import type {
  PlacesMeter,
  PlacesSku,
} from "@plugins/integrations/plugins/google-maps/plugins/places-api/core";
import { billingMonth } from "../../core";
import { _googleMapsUsage } from "./tables";

/** Count one call of `sku` in the current billing month. */
export async function recordPlacesCall(
  sku: PlacesSku,
  now: Date = new Date(),
): Promise<void> {
  const month = billingMonth(now).key;
  await db
    .insert(_googleMapsUsage)
    .values({ usageKey: `${month}:${sku}`, month, sku, calls: 1 })
    .onConflictDoUpdate({
      target: _googleMapsUsage.usageKey,
      set: {
        calls: sql`${_googleMapsUsage.calls} + 1`,
        lastCalledAt: sql`now()`,
      },
    });
}

/** The meter every server-side `PlacesClient` counts its calls on. */
export const placesMeter: PlacesMeter = {
  record: (sku) => recordPlacesCall(sku),
};
