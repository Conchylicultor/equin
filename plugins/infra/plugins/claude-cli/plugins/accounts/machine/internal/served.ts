import { serveValue } from "@plugins/network/plugins/live/machine";
import { getConfig, watchConfig } from "@plugins/config_v2/server";
import { profileNameConfig } from "@plugins/infra/plugins/host-account/core";
import { claudeAccounts, withStandInNames } from "../../core";
import { readClaudeAccounts } from "./store";
import { watchClaudeAccounts } from "./watch";

/**
 * The name the added accounts are shown under while the user shows no name
 * (Settings → Config, host-account's profile-name setting): their own names
 * are the user's labels, often a person's name.
 */
const GENERIC_ACCOUNT_NAME = "Claude";

/**
 * `claude-accounts`: re-read whenever any backend rewrites the accounts file
 * (its directory holds nothing else but the rename's temp file), or the user's
 * profile-name setting changes — with the name turned off, every added account
 * is shown under a generic name (the accounts file itself is never touched).
 */
export const claudeAccountsServed = serveValue(claudeAccounts, {
  source: "external",
  changes: "notified",
  throttleMs: 100,
  loader: async () =>
    withStandInNames(
      await readClaudeAccounts(),
      getConfig(profileNameConfig).showName ? "" : GENERIC_ACCOUNT_NAME,
    ),
  whileSubscribed: async (_params, notify) => {
    const release = await watchClaudeAccounts(() => notify());
    // A write between the first read and the watch opening produced no event.
    notify();
    const unwatch = watchConfig(profileNameConfig, () => notify());
    return () => {
      unwatch.dispose();
      release();
    };
  },
});
