import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

// The Claude accounts agents can run on. One is always there: the account the
// computer's Claude Code is signed into (`claude auth login`, its keychain).
// The others are added with a long-lived token from `claude setup-token`; the
// token lives in the encrypted secrets store, never in this list. The choice
// is the machine's — every worktree's agents launch on the active account.

/** The account the computer's Claude Code is signed into. */
export const SYSTEM_ACCOUNT_ID = "system";

export const ClaudeAccountSchema = z.object({
  id: z.string().min(1),
  /** The user's name for it: "Work", "Personal". */
  name: z.string().min(1),
  /** When it was added, epoch milliseconds. */
  addedAt: z.number().int().positive(),
});
export type ClaudeAccount = z.infer<typeof ClaudeAccountSchema>;

export const ClaudeAccountsSchema = z.object({
  /** The token accounts, in the order they were added. */
  accounts: z.array(ClaudeAccountSchema),
  /** The account new agents launch on: {@link SYSTEM_ACCOUNT_ID} or a token account's id. */
  active: z.string().min(1),
  /** Launch on the account with the most weekly room left when the active one has hit a limit. */
  autoSwitch: z.boolean(),
});
export type ClaudeAccounts = z.infer<typeof ClaudeAccountsSchema>;

/** Nothing added yet: the system account alone. */
export const NO_CLAUDE_ACCOUNTS: ClaudeAccounts = {
  accounts: [],
  active: SYSTEM_ACCOUNT_ID,
  autoSwitch: false,
};

/** Every account id: the system one first, then the token accounts. */
export function claudeAccountIds(state: ClaudeAccounts): string[] {
  return [SYSTEM_ACCOUNT_ID, ...state.accounts.map((a) => a.id)];
}

/**
 * What `claude setup-token` prints. Checked for its shape only: whether it
 * still signs in shows on the first agent launched with it.
 */
export const ClaudeTokenSchema = z
  .string()
  .trim()
  .regex(/^sk-ant-[A-Za-z0-9_-]{20,}$/, "Not a Claude token (sk-ant-…)");

/** The accounts and the active one, pushed whenever they change. */
export const claudeAccounts = liveValue("claude-accounts", {
  schema: ClaudeAccountsSchema,
  needsMachine: { feature: "Switching Claude accounts" },
});

export const addClaudeAccount = defineEndpoint({
  route: "POST /api/claude-accounts/add",
  body: z.object({ name: z.string().trim().min(1), token: ClaudeTokenSchema }),
  response: ClaudeAccountSchema,
  needsMachine: { feature: "Switching Claude accounts" },
});

export const removeClaudeAccount = defineEndpoint({
  route: "POST /api/claude-accounts/remove",
  body: z.object({ id: z.string().min(1) }),
  needsMachine: { feature: "Switching Claude accounts" },
});

export const selectClaudeAccount = defineEndpoint({
  route: "POST /api/claude-accounts/select",
  body: z.object({ id: z.string().min(1) }),
  needsMachine: { feature: "Switching Claude accounts" },
});

export const setClaudeAccountAutoSwitch = defineEndpoint({
  route: "POST /api/claude-accounts/auto-switch",
  body: z.object({ enabled: z.boolean() }),
  needsMachine: { feature: "Switching Claude accounts" },
});
