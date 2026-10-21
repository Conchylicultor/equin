import { z } from "zod";
import { defineThreadResult } from "@plugins/conversations/plugins/agent-thread/core";
import { PICKS_TOOL } from "./ids";

/** At most this many picks per answer: a short list to choose from, not a search page. */
export const MAX_PICKS = 8;

/** The longest `about` a pick may carry: a few sentences, not an article. */
export const MAX_ABOUT_CHARS = 400;

/** At most this many sources per pick. */
export const MAX_PICK_SOURCES = 3;

/** A page the agent read about a pick: its title and address. */
export const PickSourceSchema = z.object({
  title: z
    .string()
    .min(1)
    .max(200)
    .describe(
      'The page\'s title or site, e.g. "The Infatuation — Best Ramen in Paris".',
    ),
  url: z.string().url().describe("The page's URL."),
});
export type PickSource = z.infer<typeof PickSourceSchema>;

/**
 * Sonnet's answer to one turn: the places it picks, best first, each with the
 * reason it fits the question: `why` (the checked facts, one line), `about`
 * (what makes it special, from the agent's web sources) and the `sources`
 * themselves. Only ids for the place — the card is drawn from the Google
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
        // Optional only so picks stored before it existed still parse (the
        // thread's history is shown); the tool and the instructions require it.
        about: z
          .string()
          .min(1)
          .max(MAX_ABOUT_CHARS)
          .optional()
          .describe(
            "Required. 1–3 sentences: what makes this place special and why you chose it for this question, from what your sources say (the dish people go for, the view, the atmosphere).",
          ),
        sources: z
          .array(PickSourceSchema)
          .max(MAX_PICK_SOURCES)
          .optional()
          .describe(
            "Where you read about it (a blog, a local guide, a Reddit thread, a vlog): at most 3, the pages you actually used. Omit when you found it on Maps alone.",
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
