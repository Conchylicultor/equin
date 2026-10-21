import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import {
  addClaudeAccount,
  removeClaudeAccount,
  selectClaudeAccount,
  setClaudeAccountAutoSwitch,
} from "../core";
import {
  handleAdd,
  handleAutoSwitch,
  handleRemove,
  handleSelect,
} from "./internal/routes";
import { claudeAccountsServed } from "./internal/served";

export { readClaudeAccounts, selectClaudeAccountById } from "./internal/store";

export default {
  description:
    "The Claude accounts, desktop-only half: the machine-wide accounts file (each added account's name, the active one, auto-switch — readClaudeAccounts, selectClaudeAccountById), served as the claude-accounts push value off a watch of it, and the add / remove / select / auto-switch endpoints that rewrite it (a token goes to the secrets store).",
  httpRoutes: {
    [addClaudeAccount.route]: handleAdd,
    [removeClaudeAccount.route]: handleRemove,
    [selectClaudeAccount.route]: handleSelect,
    [setClaudeAccountAutoSwitch.route]: handleAutoSwitch,
  },
  contributions: [...claudeAccountsServed.declare],
} satisfies MachinePluginDefinition;
