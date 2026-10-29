import { z } from "zod";
import { liveValue, patchValue } from "@plugins/network/plugins/live/core";
import { wholeList } from "@plugins/packages/plugins/list-bound/core";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

// The Claude accounts agents can run on. One is always there: the account the
// computer's Claude Code is signed into (`claude auth login`, its keychain).
// The others are added with a credential — a long-lived plan token from
// `claude setup-token`, or an API key (billed to the Console org, e.g. the
// plan's monthly API credit); the credential lives in the encrypted secrets
// store, never in this list. The choice is the machine's — every worktree's
// agents launch on the active account.

/** The account the computer's Claude Code is signed into. */
export const SYSTEM_ACCOUNT_ID = "system";

/**
 * The credentials an added account can hold, as data: what each one starts
 * with, and the environment variable it reaches Claude Code in. A credential's
 * kind is derived from its prefix — never stated separately — so the variable
 * an agent signs in through cannot disagree with what was pasted.
 */
export const CLAUDE_CREDENTIALS = {
  /** A plan sign-in from `claude setup-token`: draws on the plan's limits. */
  token: { prefix: "sk-ant-oat", env: "CLAUDE_CODE_OAUTH_TOKEN" },
  /** A Console API key: billed per use to its organization, no plan limits. */
  "api-key": { prefix: "sk-ant-api", env: "ANTHROPIC_API_KEY" },
} as const;
export type ClaudeCredentialKind = keyof typeof CLAUDE_CREDENTIALS;
const CREDENTIAL_KINDS = Object.keys(CLAUDE_CREDENTIALS) as [
  ClaudeCredentialKind,
  ...ClaudeCredentialKind[],
];

/** Every variable a credential reaches Claude Code in. Its presence is how a session knows it runs on an added account. */
export const CLAUDE_CREDENTIAL_ENVS: readonly string[] = CREDENTIAL_KINDS.map(
  (k) => CLAUDE_CREDENTIALS[k].env,
);

/** The kind of credential `secret` is, or `null` when it is neither. */
function credentialKindOf(secret: string): ClaudeCredentialKind | null {
  return (
    CREDENTIAL_KINDS.find((k) =>
      secret.startsWith(CLAUDE_CREDENTIALS[k].prefix),
    ) ?? null
  );
}

/**
 * What a user pastes: a plan token (`sk-ant-oat…`) or an API key
 * (`sk-ant-api…`). Checked for its shape only: whether it still signs in shows
 * on the first agent launched with it.
 */
export const ClaudeCredentialSchema = z
  .string()
  .trim()
  .regex(/^sk-ant-[A-Za-z0-9_-]{20,}$/, "Not a Claude credential (sk-ant-…)")
  .refine(
    (s) => credentialKindOf(s) !== null,
    "Neither a token from `claude setup-token` (sk-ant-oat…) nor an API key (sk-ant-api…)",
  );

/** The kind of a credential that passed {@link ClaudeCredentialSchema}; throws on any other string. */
export function claudeCredentialKind(secret: string): ClaudeCredentialKind {
  const kind = credentialKindOf(secret);
  if (!kind) throw new Error("Not a Claude token or API key");
  return kind;
}

/** An added account's credential, as an agent signs in with it. */
export interface ClaudeCredential {
  kind: ClaudeCredentialKind;
  secret: string;
}

/**
 * Claude Code's environment for `credential`: `base` without any credential
 * variable, plus the one this credential's kind uses — so a variable inherited
 * from elsewhere can never sign an agent in as another account.
 */
export function claudeCredentialEnv(
  base: Readonly<Record<string, string | undefined>>,
  credential: ClaudeCredential,
): Record<string, string | undefined> {
  const env = { ...base };
  for (const name of CLAUDE_CREDENTIAL_ENVS) delete env[name];
  env[CLAUDE_CREDENTIALS[credential.kind].env] = credential.secret;
  return env;
}

export const ClaudeAccountSchema = z.object({
  id: z.string().min(1),
  /** The user's name for it: "Work", "Personal". */
  name: z.string().min(1),
  /** When it was added, epoch milliseconds. */
  addedAt: z.number().int().positive(),
  /**
   * The kind of credential it holds, derived from it when added. Accounts
   * files written before API keys existed hold tokens only.
   */
  kind: z.enum(CREDENTIAL_KINDS).default("token"),
});
export type ClaudeAccount = z.infer<typeof ClaudeAccountSchema>;

export const ClaudeAccountsSchema = z.object({
  /** The added accounts, in the order they were added. */
  accounts: wholeList(ClaudeAccountSchema, {
    reason: "the Claude accounts the user added by hand — a handful",
  }),
  /** The account new agents launch on: {@link SYSTEM_ACCOUNT_ID} or an added account's id. */
  active: z.string().min(1),
  /**
   * Launch on the account with the most weekly room left when the active one
   * has hit a limit — an API key only while every plan account has.
   */
  autoSwitch: z.boolean(),
});
export type ClaudeAccounts = z.infer<typeof ClaudeAccountsSchema>;

/** Nothing added yet: the system account alone. */
export const NO_CLAUDE_ACCOUNTS: ClaudeAccounts = {
  accounts: [],
  active: SYSTEM_ACCOUNT_ID,
  autoSwitch: false,
};

/** Every account id: the system one first, then the added accounts. */
export function claudeAccountIds(state: ClaudeAccounts): string[] {
  return [SYSTEM_ACCOUNT_ID, ...state.accounts.map((a) => a.id)];
}

/**
 * Every account as a launch weighs it, the system one first. `metered`: billed
 * per use (an API key) — no plan limits, so nothing ever says it is full.
 */
export function claudeAccountRefs(
  state: ClaudeAccounts,
): { id: string; metered: boolean }[] {
  return [
    { id: SYSTEM_ACCOUNT_ID, metered: false },
    ...state.accounts.map((a) => ({ id: a.id, metered: a.kind === "api-key" })),
  ];
}

/** The accounts and the active one, pushed whenever they change. */
export const claudeAccounts = liveValue("claude-accounts", {
  schema: ClaudeAccountsSchema,
  needsMachine: { feature: "Switching Claude accounts" },
});

export const addClaudeAccount = defineEndpoint({
  route: "POST /api/claude-accounts/add",
  unpredicted: {
    reason: "server-minted-id",
    why: "the server mints the account id and addedAt and the card renders the stored account from the answer",
  },
  body: z.object({
    name: z.string().trim().min(1),
    credential: ClaudeCredentialSchema,
  }),
  response: ClaudeAccountSchema,
  needsMachine: { feature: "Switching Claude accounts" },
});

export const removeClaudeAccount = defineEndpoint({
  route: "POST /api/claude-accounts/remove",
  effect: (on) =>
    patchValue(
      on,
      claudeAccounts,
      () => ({}),
      (state, { body }) => ({
        ...state,
        accounts: state.accounts.filter((a) => a.id !== body.id),
        active: state.active === body.id ? SYSTEM_ACCOUNT_ID : state.active,
      }),
    ),
  body: z.object({ id: z.string().min(1) }),
  needsMachine: { feature: "Switching Claude accounts" },
});

export const selectClaudeAccount = defineEndpoint({
  route: "POST /api/claude-accounts/select",
  effect: (on) =>
    patchValue(
      on,
      claudeAccounts,
      () => ({}),
      (state, { body }) => ({ ...state, active: body.id }),
    ),
  body: z.object({ id: z.string().min(1) }),
  needsMachine: { feature: "Switching Claude accounts" },
});

export const setClaudeAccountAutoSwitch = defineEndpoint({
  route: "POST /api/claude-accounts/auto-switch",
  effect: (on) =>
    patchValue(
      on,
      claudeAccounts,
      () => ({}),
      (state, { body }) => ({ ...state, autoSwitch: body.enabled }),
    ),
  body: z.object({ enabled: z.boolean() }),
  needsMachine: { feature: "Switching Claude accounts" },
});
