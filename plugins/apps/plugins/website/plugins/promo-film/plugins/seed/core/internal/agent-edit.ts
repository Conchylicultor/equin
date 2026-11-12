import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

/**
 * The film's shops agent writing the page, as an agent writes one: ONE
 * `edit_page` (agent-access's `pageTools.edit`, the very function the MCP
 * tool calls) on the Buying a piano page, inserting every shop of
 * `PIANO_SHOPS_ADDED` (a to-do with its place under it), a blank line and a
 * map right after the user's last shop — one apply, one locked transaction,
 * so the open page receives it as one push. The page must be an Agent page
 * by then (the film turns it into one first): the edit is judged by the same
 * policy as a real agent's. Refused anywhere but the film's own instance.
 * Answers the ids the apply created, in no promised order.
 */
export const writeFilmShops = defineEndpoint({
  route: "POST /api/promo-film/agent-shops",
  body: z.object({}),
  response: z.object({ createdIds: z.array(z.string()) }),
  needsMachine: { feature: "Writing the showcase film's shops" },
});
