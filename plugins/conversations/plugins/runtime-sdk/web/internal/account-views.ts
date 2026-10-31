import {
  claudeAccountRefs,
  SYSTEM_ACCOUNT_ID,
  type ClaudeAccounts,
} from "@plugins/infra/plugins/claude-cli/plugins/accounts/core";
import type { ClaudeCodeStatus } from "@plugins/infra/plugins/claude-cli/plugins/availability/core";
import { launchAccount, type ClaudeUsageRead } from "../../core";

// The Claude accounts as every surface lists them: the computer's own login
// first, then the added ones — each with a name and one line of detail.

export interface AccountView {
  id: string;
  name: string;
  detail: string;
  /** Billed per use (an API key): no plan limits to read or show. */
  metered: boolean;
}

/** The accounts in display order: the computer's own login first. */
export function accountViews(
  accounts: ClaudeAccounts,
  claude: ClaudeCodeStatus,
): AccountView[] {
  const login =
    claude.kind === "ready"
      ? (claude.email ?? claude.authMethod ?? "Claude Code's sign-in")
      : "Claude Code's sign-in";
  return [
    {
      id: SYSTEM_ACCOUNT_ID,
      name: "This computer",
      detail: login,
      metered: false,
    },
    ...accounts.accounts.map((a) => ({
      id: a.id,
      name: a.name,
      detail: a.kind === "api-key" ? "API key" : "Plan sign-in",
      metered: a.kind === "api-key",
    })),
  ];
}

/** The account new agents launch on, as listed. */
export function activeAccountView(
  accounts: ClaudeAccounts,
  views: readonly AccountView[],
): AccountView {
  const active = views.find((v) => v.id === accounts.active);
  if (!active) {
    throw new Error(
      `Claude accounts: the active account "${accounts.active}" is not one of ${views.map((v) => v.id).join(", ")}`,
    );
  }
  return active;
}

/** Where an agent restarted now runs: the launch's own choice. */
export function launchAccountView(
  accounts: ClaudeAccounts,
  views: readonly AccountView[],
  usage: ClaudeUsageRead,
  now: number,
): AccountView {
  const id = launchAccount({
    accounts: claudeAccountRefs(accounts),
    active: accounts.active,
    autoSwitch: accounts.autoSwitch,
    byAccount: usage.byAccount,
    now,
  });
  return views.find((v) => v.id === id) ?? activeAccountView(accounts, views);
}
