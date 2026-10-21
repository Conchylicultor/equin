import { defineDataDir } from "@plugins/infra/plugins/paths/core";

/**
 * The Claude accounts agents can run on: `accounts.json` — each added
 * account's name and id, the active one and the auto-switch choice. Their
 * tokens are in the secrets store, never here. Machine-wide: every
 * worktree's agents launch on the active account.
 */
export const claudeAccountsDir = defineDataDir({
  kind: "state",
  name: "claude-accounts",
  owner: "infra/claude-cli/accounts",
  description:
    "The Claude accounts agents can run on (names, the active one, auto-switch); their tokens live in the secrets store",
  reclaim: {
    kind: "never",
    reason:
      "the only record of which accounts were added and which one agents launch on",
  },
});

export default [claudeAccountsDir];
