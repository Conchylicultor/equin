import { z } from "zod";
import { defineThreadResult } from "@plugins/conversations/plugins/agent-thread/core";
import { PICKS_TOOL } from "./ids";

/** At most this many picks per answer: a short list to choose from, not a search page. */
export const MAX_PICKS = 8;

/**
 * Sonnet's answer to one turn: the places it picks, best first, each with the
 * reason it fits the question. Only ids — the card is drawn from the Google
 * candidate the run's own search returned (`askCandidates`), so a pick carries
 * no copied rating or hours that could be wrong.
 */
export const PlacesPicksSchema = z.object({
  picks: z
    .array(
      z.object({
        googlePlaceId: z
          .string()
          .min(1)
          .describe("The placeId of a place your places_search_text returned."),
        why: z
          .string()
          .min(1)
          .max(200)
          .describe(
            'One line: the facts you checked that make it fit, e.g. "Open Tue 12:00–22:30 · €€ · 4.6★ from 1.2k reviews".',
          ),
      }),
    )
    .max(MAX_PICKS),
});
export type PlacesPicks = z.infer<typeof PlacesPicksSchema>;

/** The result kind of an Ask Sonnet thread (`places_show_picks`). */
export const placesPicks = defineThreadResult({
  tool: PICKS_TOOL,
  schema: PlacesPicksSchema,
  count: (p) => p.picks.length,
});
