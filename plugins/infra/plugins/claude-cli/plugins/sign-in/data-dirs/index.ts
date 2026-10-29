import { defineDataDir } from "@plugins/infra/plugins/paths/core";

/**
 * The running sign-in's scratch files, one folder per run: the BROWSER shim
 * Claude Code hands its sign-in page to, the page it handed, Claude Code's
 * output, and (for a new account) its own config dir. Deleted when the run
 * ends — the output can hold a new account's token until it is saved.
 */
export const claudeSignInDir = defineDataDir({
  kind: "cache",
  name: "claude-sign-in",
  owner: "infra/claude-cli/sign-in",
  description:
    "The running Claude sign-in's scratch files (browser shim, the page it opened, Claude Code's output), deleted when it ends",
  reclaim: { kind: "restart" },
});

export default [claudeSignInDir];
