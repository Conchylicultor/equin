import { defineScratchProfile } from "@plugins/conversations/plugins/workspace/server";
import {
  PICKS_TOOL,
  PLACES_ASK_PROFILE,
  PlacesAskInputSchema,
  SEARCH_TOOL,
} from "../../core";
import { askInstructions } from "./instructions";

/**
 * The Ask Sonnet agent's workspace: an empty scratch directory whose CLAUDE.md
 * is the question's context (the map's area, the user's clock). Its tools: the
 * built-in WebSearch / WebFetch (research — blogs, guides and Reddit find
 * better places than Maps alone), the Google search, the picks tool and
 * `flag_raise` — no shell, no file edits, no `exit_clean`: it ends its turn
 * instead, so the user can reply in the thread. The session runs in bypass
 * mode, so every built-in tool the deny list leaves out is usable; `allow`
 * states the two web tools anyway, so the intent survives a mode change.
 */
export const placesAskProfile = defineScratchProfile({
  id: PLACES_ASK_PROFILE,
  label: "Places: Ask Sonnet",
  description:
    "Places Ask Sonnet: a natural-language place search around the map, answered as picks on the map.",
  inputSchema: PlacesAskInputSchema,
  instructions: askInstructions,
  mcpTools: [SEARCH_TOOL, PICKS_TOOL, "flag_raise"],
  permissions: {
    allow: ["WebSearch", "WebFetch"],
    deny: ["Bash", "Write", "Edit", "NotebookEdit"],
  },
});
