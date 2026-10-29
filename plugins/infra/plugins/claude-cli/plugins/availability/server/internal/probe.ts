import type { SDKControlInitializeResponse } from "@anthropic-ai/claude-agent-sdk";
import { SYSTEM_ACCOUNT_ID } from "@plugins/infra/plugins/claude-cli/plugins/accounts/core";
import {
  claudeSessionEnv,
  readClaudeInitialize,
} from "@plugins/infra/plugins/claude-cli/plugins/sdk/server";
import type { ClaudeCodeStatus } from "../../core";

/** CLI start-up plus its `initialize` answer; a ceiling, not an estimate. */
const PROBE_TIMEOUT_MS = 20_000;

/**
 * What one `initialize` says about the computer's sign-in. Signed in (Claude
 * Code 2.1.308): `account: {email, organization, subscriptionType: "Claude
 * Max", apiProvider: "firstParty"}`; signed out: `account: {tokenSource:
 * "none", apiProvider: "firstParty"}`. A third-party provider (Bedrock,
 * Vertex, …) signs in outside Claude Code, so it counts as signed in.
 */
export function statusOfInitialize(
  init: Pick<SDKControlInitializeResponse, "account" | "claude_code_version">,
): ClaudeCodeStatus {
  const version = init.claude_code_version;
  if (version === undefined)
    return {
      kind: "unreadable",
      error: "Claude Code's initialize answer carried no version",
    };
  const { account } = init;
  const has = (source: string | undefined) =>
    source !== undefined && source !== "none";
  const signedIn =
    (account.apiProvider !== undefined &&
      account.apiProvider !== "firstParty") ||
    account.email !== undefined ||
    has(account.tokenSource) ||
    has(account.apiKeySource);
  if (!signedIn) return { kind: "signed-out", version };
  const authMethod =
    account.subscriptionType ??
    [account.tokenSource, account.apiKeySource].find(has) ??
    (account.apiProvider !== "firstParty" ? account.apiProvider : undefined);
  return {
    kind: "ready",
    version,
    authMethod: authMethod ?? null,
    email: account.email ?? null,
  };
}

/**
 * Ask the machine, now: is Claude Code signed in?
 *
 * One Agent SDK session on the computer's own login (the system account),
 * under the host facts alone — the account the status is about — that reads
 * its `initialize` answer and closes. Never throws for a Claude Code problem:
 * every way the answer can come out is an arm of {@link ClaudeCodeStatus}.
 */
export async function probeClaudeCode(): Promise<ClaudeCodeStatus> {
  try {
    return statusOfInitialize(
      await readClaudeInitialize({
        env: await claudeSessionEnv(SYSTEM_ACCOUNT_ID),
        cwd: "/tmp",
        timeoutMs: PROBE_TIMEOUT_MS,
      }),
    );
  } catch (err) {
    // The check itself failed (timed out, the CLI crashed, the SDK's bundled
    // build is not installed): not a verdict.
    if (!(err instanceof Error)) throw err;
    return {
      kind: "unreadable",
      error: `Claude Code's initialize failed: ${err.message.slice(0, 300)}`,
    };
  }
}
