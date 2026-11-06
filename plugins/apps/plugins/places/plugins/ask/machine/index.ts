import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ScratchProfile } from "@plugins/conversations/plugins/workspace/server";
import { placesAskProfile } from "./internal/profile";
import { searchTextTool, showPicksTool } from "./internal/tools";

export default {
  description:
    "Ask Sonnet in the Places search bar, desktop half: the places.ask scratch profile (CLAUDE.md = the map's area, its span and the user's clock, and the method: web research first — WebSearch / WebFetch over blogs, guides, Reddit — then each candidate looked up on Maps; no shell, no exit_clean, so the run stays repliable), its places_search_text tool (Google Text Search biased to the launch's map area, on the search bar's downgrade ladder read server-side) and places_show_picks (the thread's result — each pick a why, an about and its sources — refusing any id the run's searches never returned and any pick without an about).",
  register: [
    ScratchProfile.define(placesAskProfile),
    searchTextTool,
    showPicksTool,
  ],
} satisfies MachinePluginDefinition;
