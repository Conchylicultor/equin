import { acquireDirWatch } from "@plugins/infra/plugins/file-watcher/server";
import { serveValue } from "@plugins/network/plugins/live/machine";
import { claudeAccounts } from "../../core";
import { claudeAccountsDir } from "../../data-dirs";
import { readClaudeAccounts } from "./store";

/**
 * `claude-accounts`: re-read whenever any backend rewrites the accounts file
 * (its directory holds nothing else but the rename's temp file).
 */
export const claudeAccountsServed = serveValue(claudeAccounts, {
  source: "external",
  changes: "notified",
  throttleMs: 100,
  loader: readClaudeAccounts,
  whileSubscribed: async (_params, notify) => {
    const release = await acquireDirWatch({
      dir: claudeAccountsDir.ensure(),
      scope: "subtree",
      onChange: () => notify(),
    });
    // A write between the first read and the watch opening produced no event.
    notify();
    return release;
  },
});
