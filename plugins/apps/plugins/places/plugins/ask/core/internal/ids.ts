// The scratch profile an Ask Sonnet run is launched under (the agent's
// CLAUDE.md, its tools) — the thread's kind, which `useThreadRuns` reads back.
export const PLACES_ASK_PROFILE = "places.ask";

// The category the Places app files its tasks under (an Ask Sonnet run is one).
// The server barrel contributes the matching TaskCategory registration.
export const PLACES_CATEGORY_ID = "places";

// The tools of the profile, by their own names (the transcript calls them
// `mcp__<server>__<name>`).
export const SEARCH_TOOL = "places_search_text";
export const PICKS_TOOL = "places_show_picks";
