import { acquireDirWatch } from "@plugins/infra/plugins/file-watcher/server";
import { claudeAccountsDir } from "../../data-dirs";

/**
 * Run `onChange` whenever any backend rewrites the accounts file — an account
 * added or removed, another one made active, auto-switch toggled. Its
 * directory holds nothing else but the rename's temp file. Resolves to the
 * release once the watch is open.
 */
export async function watchClaudeAccounts(
  onChange: () => void,
): Promise<() => void> {
  return acquireDirWatch({
    dir: await claudeAccountsDir.ensure(),
    scope: "subtree",
    onChange,
  });
}
