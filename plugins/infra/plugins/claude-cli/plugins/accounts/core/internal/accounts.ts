import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import { wholeList } from "@plugins/packages/plugins/list-bound/core";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

// The Claude accounts agents can run on. One is always there: the account the
// computer's Claude Code is signed into (its keychain; signed in from the app,
// `claude-cli/sign-in`) — the only plan (subscription) account equin runs on.
// The others are Anthropic API keys (billed per use to their Console org, e.g.
// the plan's monthly API credit), pasted by the user; the key lives in the
// encrypted secrets store, never in this list. The choice is the machine's —
// every worktree's agents launch on the active account.
//
// No added plan accounts. equin once signed in to more plans (Claude Code's
// `setup-token`) and kept their tokens; Anthropic's terms say developers may
// not "collect, store, or intermediate Claude.ai credentials or session
// tokens", and plan limits "assume ordinary, individual usage". A plan account
// is Claude Code's own login, which Claude Code stores itself. Files written
// before hold such accounts; the machine half drops them (`store.ts`).

/** The account the computer's Claude Code is signed into. */
export const SYSTEM_ACCOUNT_ID = "system";

/**
 * What an API key starts with: `sk-ant-api` is the original shape; keys the
 * Console creates since ~2026-10 (personal / workspace keys) start with
 * `sk-ant-usr`.
 */
export const API_KEY_PREFIXES = ["sk-ant-api", "sk-ant-usr"] as const;

/** The variable an added account's API key reaches Claude Code in. */
const API_KEY_ENV = "ANTHROPIC_API_KEY";

/**
 * Every variable that signs Claude Code in from the environment, removed from
 * an agent's environment but for the one its account sets — so a variable
 * inherited from elsewhere can never sign an agent in as another account.
 * `CLAUDE_CODE_OAUTH_TOKEN` (a plan token) is never set by equin, only
 * stripped. Its presence is also how a session knows it does not run on the
 * computer's own login (`guard/`).
 */
export const CLAUDE_CREDENTIAL_ENVS: readonly string[] = [
  API_KEY_ENV,
  "CLAUDE_CODE_OAUTH_TOKEN",
];

/**
 * What a user pastes: an API key (`sk-ant-api…` / `sk-ant-usr…`). Checked
 * for its shape only: whether it still signs in shows on the first agent
 * launched with it.
 */
export const ClaudeCredentialSchema = z
  .string()
  .trim()
  .regex(/^sk-ant-[A-Za-z0-9_-]{20,}$/, "Not a Claude credential (sk-ant-…)")
  .refine(
    (s) => API_KEY_PREFIXES.some((p) => s.startsWith(p)),
    "Not an API key (sk-ant-api… / sk-ant-usr…)",
  );

/**
 * Claude Code's environment for an added account's `apiKey`: `base` without
 * any credential variable, plus the API key.
 */
export function claudeCredentialEnv(
  base: Readonly<Record<string, string | undefined>>,
  apiKey: string,
): Record<string, string | undefined> {
  const env = { ...base };
  for (const name of CLAUDE_CREDENTIAL_ENVS) delete env[name];
  env[API_KEY_ENV] = apiKey;
  return env;
}

/** An added account: an API key, billed per use — no plan limits. */
export const ClaudeAccountSchema = z.object({
  id: z.string().min(1),
  /** The user's name for it: "Work", "Personal". */
  name: z.string().min(1),
  /** When it was added, epoch milliseconds. */
  addedAt: z.number().int().positive(),
});
export type ClaudeAccount = z.infer<typeof ClaudeAccountSchema>;

export const ClaudeAccountsSchema = z.object({
  /** The added accounts, in the order they were added. */
  accounts: wholeList(ClaudeAccountSchema, {
    reason: "the Claude accounts the user added by hand — a handful",
  }),
  /** The account new agents launch on: {@link SYSTEM_ACCOUNT_ID} or an added account's id. */
  active: z.string().min(1),
});
export type ClaudeAccounts = z.infer<typeof ClaudeAccountsSchema>;

/** Nothing added yet: the system account alone. */
export const NO_CLAUDE_ACCOUNTS: ClaudeAccounts = {
  accounts: [],
  active: SYSTEM_ACCOUNT_ID,
};

/** Every account id: the system one first, then the added accounts. */
export function claudeAccountIds(state: ClaudeAccounts): string[] {
  return [SYSTEM_ACCOUNT_ID, ...state.accounts.map((a) => a.id)];
}

/** The accounts and the active one, pushed whenever they change. */
export const claudeAccounts = liveValue("claude-accounts", {
  schema: ClaudeAccountsSchema,
  needsMachine: { feature: "Switching Claude accounts" },
});

export const addClaudeAccount = defineEndpoint({
  route: "POST /api/claude-accounts/add",
  body: z.object({
    name: z.string().trim().min(1),
    credential: ClaudeCredentialSchema,
  }),
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
