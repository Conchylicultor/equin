import { defineScratchProfile } from "@plugins/conversations/plugins/workspace/server";
import { AskInputSchema, FILE_TASK_TOOL, HELP_ASK_PROFILE } from "../../core";
import { checkoutRootPath } from "./checkout";
import { askInstructions } from "./instructions";
import { copyRepoContext } from "./repo-context";

/**
 * The Ask equin agent's workspace: a scratch directory whose CLAUDE.md is the
 * question's context (where the user is, the page outline) and imports the
 * repo's own CLAUDE.md (copied in at launch, `copyRepoContext`), pointing at
 * the main checkout to explore. It reads anything — Read / Grep / Glob, and
 * Bash in Claude Code's sandbox (`sandbox: true`: commands write only inside
 * the scratch dir, so `git log` or `rg` over the checkout work and nothing can
 * change it) — and edits nothing (Write / Edit denied; the session runs in
 * bypass mode, so `deny` is what removes a tool). Its MCP tools are the task
 * filing tool and `flag_raise` — no `add_task` (whose dependency wiring and
 * auto-start rules are for working agents), no `exit_clean`: it ends its turn
 * instead, so the user can reply in the thread.
 */
export const helpAskProfile = defineScratchProfile({
  id: HELP_ASK_PROFILE,
  label: "Ask equin",
  description:
    "Ask equin: a read-only how-to helper answering from equin's own code and history, with the page the user asked from.",
  inputSchema: AskInputSchema,
  instructions: (input) => askInstructions(input, checkoutRootPath()),
  mcpTools: [FILE_TASK_TOOL, "flag_raise"],
  permissions: {
    allow: ["Read", "Grep", "Glob", "Bash"],
    deny: ["Write", "Edit", "NotebookEdit"],
  },
  sandbox: true,
  prepare: ({ dir }) => copyRepoContext(checkoutRootPath(), dir),
});
