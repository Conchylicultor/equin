import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import {
  PlaceRichDetailsSchema,
  RICH_DETAILS_TIERS,
} from "@plugins/integrations/plugins/google-maps/plugins/places-api/core";
import { MapsNotConfiguredSchema } from "@plugins/apps/plugins/places/plugins/places-core/core";

export const PlaceDetailsQuerySchema = z.object({
  googlePlaceId: z.string().min(1),
});
export type PlaceDetailsQuery = z.infer<typeof PlaceDetailsQuerySchema>;

/**
 * One place's rich details, or why there are none: `unavailable` when Google
 * refused this place id (it no longer knows it) — the card then shows the
 * stored facts alone; `maps-not-configured` when no Places key is stored.
 *
 * `ok` says how rich it is: `tier` is the rung of the downgrade ladder
 * (`detailsTier`) it was fetched at, and `photosPaused` that this month's
 * Place Photo budget is spent — its photos are then left out, so a card never
 * draws images it cannot load. `resumesAt` (ISO) is when the month starts over,
 * present whenever anything was left out for the budget.
 */
export const PlaceDetailsResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ok"),
    details: PlaceRichDetailsSchema,
    tier: z.enum(RICH_DETAILS_TIERS),
    photosPaused: z.boolean(),
    resumesAt: z.string().datetime().optional(),
  }),
  z.object({ kind: z.literal("unavailable"), reason: z.string() }),
  MapsNotConfiguredSchema,
]);
export type PlaceDetailsResult = z.infer<typeof PlaceDetailsResultSchema>;

/**
 * Google's rich details of one Google place, as a typed-query value keyed by
 * its Google id. On-demand: read only while a card is open; the server keeps
 * each answer for a day.
 */
export const placeDetails = liveValue("places.details", {
  schema: PlaceDetailsResultSchema,
  query: PlaceDetailsQuerySchema,
  load: "on-demand",
});
