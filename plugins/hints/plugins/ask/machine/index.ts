import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ScratchProfile } from "@plugins/conversations/plugins/workspace/server";
import { resolveCheckoutRoot } from "./internal/checkout";
import { helpAskProfile } from "./internal/profile";

export default {
  description:
    "Ask equin, desktop-only half: the help.ask scratch profile — CLAUDE.md = the Ask equin config's Instructions template, filled with the user's page (app, route, tab title and the page outline), the main checkout to explore, and the repo's own CLAUDE.md with what it imports (copied into the scratch dir at each launch); Read / Grep / Glob and Bash in Claude Code's sandbox (reads anywhere, writes only inside its dir), no file edits, the page tools (read_page / edit_page / write_agent_note — it annotates the user's pages inside agent-authored blocks), no add_task, no exit_clean, so the run stays repliable; how to point with <show-me> and offer <go> choices. Desktop-only because it reads the checkout from disk, and a scratch session only launches on the computer.",
  register: [ScratchProfile.define(helpAskProfile)],
  // A memoized `git rev-parse`: cheap and idempotent, as the barrier requires
  // (an exec child runs it too).
  onReadyBlocking: resolveCheckoutRoot,
} satisfies MachinePluginDefinition;
