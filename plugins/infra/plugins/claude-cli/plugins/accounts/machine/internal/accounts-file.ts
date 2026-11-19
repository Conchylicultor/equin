import { wholeList } from "@plugins/packages/plugins/list-bound/core";
import { z } from "zod";
import {
  ClaudeAccountSchema,
  ClaudeAccountsSchema,
  SYSTEM_ACCOUNT_ID,
  type ClaudeAccounts,
} from "../../core";

/**
 * The accounts file. Each account's `kind` is `api-key` — the only kind
 * written since added plan accounts were removed (2026-11), and still written
 * ({@link accountsFileOf}): an older file holds `token` accounts (a plan
 * sign-in) too, and one from before API keys existed holds tokens only, with
 * no `kind` — so an account without one is a plan account.
 */
const AccountsFileSchema = ClaudeAccountsSchema.extend({
  accounts: wholeList(
    ClaudeAccountSchema.extend({
      kind: z.enum(["token", "api-key"]).optional(),
    }),
    { reason: "the Claude accounts the user added by hand — a handful" },
  ),
});

/**
 * The accounts file read: the accounts agents may run on (`state`), and the
 * ids of the plan accounts an older file still holds (`planAccounts`) — never
 * run on, the active choice falling back to the computer's own login when it
 * named one.
 */
export interface AccountsFile {
  state: ClaudeAccounts;
  planAccounts: string[];
}

export function parseAccountsFile(json: unknown): AccountsFile {
  const file = AccountsFileSchema.parse(json);
  const isPlan = (a: { kind?: "token" | "api-key" }) =>
    (a.kind ?? "token") === "token";
  const planAccounts = file.accounts.filter(isPlan).map((a) => a.id);
  const accounts = file.accounts
    .filter((a) => !isPlan(a))
    .map(({ id, name, addedAt }) => ({ id, name, addedAt }));
  return {
    state: {
      accounts,
      active: planAccounts.includes(file.active)
        ? SYSTEM_ACCOUNT_ID
        : file.active,
    },
    planAccounts,
  };
}

/** What the file holds for `state`: every account marked an API key. */
export function accountsFileOf(state: ClaudeAccounts): unknown {
  return {
    ...state,
    accounts: state.accounts.map((a) => ({ ...a, kind: "api-key" })),
  };
}
