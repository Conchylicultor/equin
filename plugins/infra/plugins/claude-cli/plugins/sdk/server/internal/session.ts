import {
  query,
  type Options,
  type Query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { claudeAccountCredential } from "@plugins/infra/plugins/claude-cli/plugins/accounts/server";
import { claudeCredentialEnv } from "@plugins/infra/plugins/claude-cli/plugins/accounts/core";
import { pickHostEnv } from "@plugins/infra/plugins/launcher/core";

// Every Claude Code session a backend opens — an agent, a one-shot generation,
// a probe — is opened here, through the Agent SDK, on an account chosen by its
// caller. Nothing drives the `claude` binary by hand (argv flags, stdout
// scraping): the `claude-sdk` lint rules reject a direct `query()` and a spawn
// of the resolved binary anywhere else.

declare const sessionEnvBrand: unique symbol;

/**
 * The environment a Claude Code session runs under: a base plus the account's
 * token. Branded, so the only way to hold one is {@link claudeSessionEnv} — a
 * session that skipped the account choice does not type-check.
 */
export type ClaudeSessionEnv = Readonly<Record<string, string | undefined>> & {
  readonly [sessionEnvBrand]: true;
};

/**
 * The environment for a session on `account`: `base` (default: the host facts
 * alone, `pickHostEnv` — never this process's own environment, whose inherited
 * Claude session variables once broke Haiku calls) plus, for an added account,
 * its credential (`claudeCredentialEnv`: `CLAUDE_CODE_OAUTH_TOKEN` for a plan
 * token, `ANTHROPIC_API_KEY` for an API key, every other credential variable
 * removed). The system account adds nothing: Claude Code signs in with the
 * computer's own login. An added account whose secret is gone throws — a
 * session never falls back to another account.
 */
export async function claudeSessionEnv(
  account: string,
  base: Readonly<Record<string, string | undefined>> = pickHostEnv(process.env),
): Promise<ClaudeSessionEnv> {
  const credential = await claudeAccountCredential(account);
  const env = credential ? claudeCredentialEnv(base, credential) : { ...base };
  return env as ClaudeSessionEnv;
}

export interface ClaudeQueryInput {
  /** From {@link claudeSessionEnv}: which account, under which environment. */
  env: ClaudeSessionEnv;
  /** The Claude Code executable (`requireClaudeBin()`, or a named hardlink to it). */
  bin: string;
  prompt: string | AsyncIterable<SDKUserMessage>;
  options: Omit<Options, "env" | "pathToClaudeCodeExecutable">;
}

/** Open one Agent SDK session — the only `query()` call outside the SDK. */
export function claudeQuery({
  env,
  bin,
  prompt,
  options,
}: ClaudeQueryInput): Query {
  return query({
    prompt,
    options: { ...options, env, pathToClaudeCodeExecutable: bin },
  });
}
