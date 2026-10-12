import { z } from "zod";
import { PlaceSuggestionSchema } from "@plugins/integrations/plugins/google-maps/plugins/places-api/core";

/**
 * "Google Maps is not set up": no Places API key is stored. An outcome, not an
 * error, so the UI renders the google-maps access affordance
 * (`MapsAccessAction`) in place of a toast.
 */
export const MapsNotConfiguredSchema = z.object({
  kind: z.literal("maps-not-configured"),
});

export const PlaceSearchQuerySchema = z.object({
  q: z.string().min(1),
  /**
   * The autocomplete session token: one per search-to-pick round, passed again
   * to the save that follows, so Google bills the pair as one session.
   */
  session: z.string().min(1),
});
export type PlaceSearchQuery = z.infer<typeof PlaceSearchQuerySchema>;

export const PlaceSearchResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ok"),
    suggestions: z.array(PlaceSuggestionSchema),
  }),
  MapsNotConfiguredSchema,
]);
export type PlaceSearchResult = z.infer<typeof PlaceSearchResultSchema>;
