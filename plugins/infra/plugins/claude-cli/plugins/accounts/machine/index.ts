import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import {
  addClaudeAccount,
  removeClaudeAccount,
  selectClaudeAccount,
} from "../core";
import { handleAdd, handleRemove, handleSelect } from "./internal/routes";
import { claudeAccountsServed } from "./internal/served";
import { activeAccountFromFile } from "./internal/store";
import { ActiveClaudeAccount } from "../server";

export {
  addClaudeAccountWithCredential,
  readClaudeAccounts,
  selectClaudeAccountById,
} from "./internal/store";
export { watchClaudeAccounts } from "./internal/watch";
export { readSystemLogin } from "./internal/system-login";
export type { SystemLogin } from "./internal/system-login";

export default {
  description:
    "The Claude accounts, desktop-only half: the machine-wide accounts file (each added account's name, the active one — readClaudeAccounts, selectClaudeAccountById), served as the claude-accounts push value off a watch of it, the active one provided as the ActiveClaudeAccount host service, and the add / remove / select endpoints that rewrite it (a token goes to the secrets store), watchClaudeAccounts — a callback on every rewrite of the file, from any backend — and readSystemLogin: the claude.ai account the computer's Claude Code is signed into (its user config's oauthAccount.accountUuid), the uuid a transcript's session-owner record names.",
  httpRoutes: {
    [addClaudeAccount.route]: handleAdd,
    [removeClaudeAccount.route]: handleRemove,
    [selectClaudeAccount.route]: handleSelect,
  },
  contributions: [
    ...claudeAccountsServed.declare,
    ActiveClaudeAccount.provide(activeAccountFromFile),
  ],
} satisfies MachinePluginDefinition;
