import { z } from "zod";
import { PlaceBoundsSchema } from "@plugins/apps/plugins/places/plugins/places-core/core";

/**
 * What a run is launched with (the scratch profile's input, written into the
 * agent's CLAUDE.md): the map's view when the question was asked — every
 * search is biased to it — and the user's clock, so "open tuesday" and
 * "tonight" name a day.
 */
export const PlacesAskInputSchema = z.object({
  bounds: PlaceBoundsSchema,
  /** The user's IANA time zone ("Europe/Paris"). */
  timeZone: z.string().min(1),
  /** When the question was asked (ISO). */
  askedAt: z.string().datetime(),
});
export type PlacesAskInput = z.infer<typeof PlacesAskInputSchema>;
