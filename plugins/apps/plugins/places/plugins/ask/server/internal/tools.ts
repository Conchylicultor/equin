import { z } from "zod";
import { Mcp } from "@plugins/infra/plugins/mcp/server";
import { workspaceOfConversation } from "@plugins/conversations/plugins/workspace/server";
import { mapsBudgetNow } from "@plugins/integrations/plugins/google-maps/plugins/usage/server";
import {
  searchRung,
  type PlaceBounds,
} from "@plugins/apps/plugins/places/plugins/places-core/core";
import { searchPlaces } from "@plugins/apps/plugins/places/plugins/places-core/server";
import {
  PICKS_TOOL,
  PLACES_ASK_PROFILE,
  PlacesAskInputSchema,
  PlacesPicksSchema,
  SEARCH_TOOL,
} from "../../core";
import { candidateIds, recordCandidates } from "./candidates";
import { searchAnswer } from "./format";
import { unknownPicks } from "./picks";

/** The map's view the run was launched over (its scratch input). */
async function boundsOf(conversationId: string): Promise<PlaceBounds> {
  const { spec } = await workspaceOfConversation(conversationId);
  if (spec.kind !== "scratch" || spec.profile !== PLACES_ASK_PROFILE) {
    throw new Error(
      `[places.ask] conversation ${conversationId} is not an Ask Sonnet run`,
    );
  }
  return PlacesAskInputSchema.parse(spec.input).bounds;
}

export const searchTextTool = Mcp.tool({
  name: SEARCH_TOOL,
  profiles: [PLACES_ASK_PROFILE],
  description: `Search Google Maps around the user's map area. Returns up to 20 places as JSON: placeId, name, type, address, rating, price and this week's opening hours (in the place's clock).`,
  inputSchema: {
    query: z
      .string()
      .min(1)
      .describe(
        'What to look for, as you would type it in Google Maps ("chinese restaurant").',
      ),
  },
  async handler({ query }, { conversationId }) {
    const bias = await boundsOf(conversationId);
    // The same downgrade ladder as the search bar: never past the month's free allowance.
    const rung = searchRung(await mapsBudgetNow());
    if (rung === "names") {
      throw new Error(
        "This month's free Google search quota is used up: tell the user you cannot search Google until next month.",
      );
    }
    const answer = await searchPlaces({
      q: query,
      bias,
      rung,
      session: crypto.randomUUID(),
    });
    if (answer.kind === "maps-not-configured") {
      throw new Error(
        "Google Maps is not set up in this app (no Places API key): tell the user to set it up in Settings → Accounts.",
      );
    }
    if (answer.kind === "names") {
      throw new Error(`[places.ask] asked rung ${rung}, got names`);
    }
    await recordCandidates(conversationId, answer.results);
    return {
      content: [
        { type: "text", text: searchAnswer(answer.results, answer.kind) },
      ],
    };
  },
});

export const showPicksTool = Mcp.tool({
  name: PICKS_TOOL,
  profiles: [PLACES_ASK_PROFILE],
  description: `Show your picks to the user: cards in the search panel and numbered pins on their map, in this order (best first). Replaces your previous picks. Only placeIds your ${SEARCH_TOOL} returned are accepted. Call it once per turn, then end your turn with one or two sentences.`,
  inputSchema: PlacesPicksSchema.shape,
  async handler({ picks }, { conversationId }) {
    const unknown = unknownPicks(picks, await candidateIds(conversationId));
    if (unknown.length > 0) {
      throw new Error(
        `Not from your searches: ${unknown.join(", ")}. Pick only placeIds ${SEARCH_TOOL} returned (search again if you need another place).`,
      );
    }
    return {
      content: [
        {
          type: "text",
          text:
            picks.length === 0
              ? "Shown: no picks. End your turn saying nothing fit, and what the user could loosen."
              : `Shown ${picks.length} picks on the map. End your turn with one or two sentences.`,
        },
      ],
    };
  },
});
