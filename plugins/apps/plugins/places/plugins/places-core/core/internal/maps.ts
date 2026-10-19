import { z } from "zod";
import {
  PlaceCandidateSchema,
  PlaceSuggestionSchema,
} from "@plugins/integrations/plugins/google-maps/plugins/places-api/core";
import { SEARCH_RUNGS } from "./search-rung";

/**
 * "Google Maps is not set up": no Places API key is stored. An outcome, not an
 * error, so the UI renders the google-maps access affordance
 * (`MapsAccessAction`) in place of a toast.
 */
export const MapsNotConfiguredSchema = z.object({
  kind: z.literal("maps-not-configured"),
});

const CornerSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

/** A box on the map — the visible area a search is biased to. */
export const PlaceBoundsSchema = z.object({
  low: CornerSchema,
  high: CornerSchema,
});
export type PlaceBounds = z.infer<typeof PlaceBoundsSchema>;

export const PlaceSearchQuerySchema = z.object({
  q: z.string().min(1),
  /** Prefer hits inside this box (a bias, not a filter): the map's view. */
  bias: PlaceBoundsSchema,
  /**
   * The ladder's rung to search at (`searchRung` over this month's budget) —
   * chosen by the reader, which holds the live counts, so the answer is a
   * Google call alone.
   */
  rung: z.enum(SEARCH_RUNGS),
  /**
   * One per search round: when the search falls back to autocomplete (`names`),
   * Google bills its keystrokes and the save that follows as one session.
   */
  session: z.string().min(1),
});
export type PlaceSearchQuery = z.infer<typeof PlaceSearchQuerySchema>;

/**
 * Google's answer to a Places search, at the rung asked (`searchRung`: the
 * richest detail this month's free allowance still covers):
 *
 * - `rich` — every hit with rating, price and this week's hours.
 * - `basic` — the rich allowance is spent: hits with name, type, address and
 *   position, no rating; `resumesAt` is when the rich detail comes back.
 * - `names` — both are spent: autocomplete names only (no position, so no
 *   pin), until `resumesAt`.
 *
 * Which rung answered is part of the answer, so the UI says so rather than
 * showing less without a word.
 */
export const PlaceSearchResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("rich"), results: z.array(PlaceCandidateSchema) }),
  z.object({
    kind: z.literal("basic"),
    results: z.array(PlaceCandidateSchema),
    resumesAt: z.string().datetime(),
  }),
  z.object({
    kind: z.literal("names"),
    suggestions: z.array(PlaceSuggestionSchema),
    resumesAt: z.string().datetime(),
  }),
  MapsNotConfiguredSchema,
]);
export type PlaceSearchResult = z.infer<typeof PlaceSearchResultSchema>;
