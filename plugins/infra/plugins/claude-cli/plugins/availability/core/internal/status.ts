import type { SDKControlInitializeResponse } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

/**
 * Can this machine run an agent right now? Every agent — and every one-shot
 * generation — is an Agent SDK session on the Claude Code build the SDK ships
 * (installed with the app's dependencies, never by the user), so the answer is
 * whether the computer is signed in to it.
 *
 * - `ready`      — signed in.
 * - `signed-out` — its initialize answer names no credential: the user signs
 *                  in from the app (`claude-cli/sign-in`).
 * - `unreadable` — the check itself failed (timed out, crashed, the bundled
 *                  build is not installed). Not a verdict on the sign-in: the
 *                  app cannot tell, and says so.
 */
export const ClaudeCodeStatusSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ready"),
    version: z.string(),
    /** How it is signed in: the subscription (`Claude Max`), or the token / API key source. */
    authMethod: z.string().nullable(),
    email: z.string().nullable(),
  }),
  z.object({ kind: z.literal("signed-out"), version: z.string() }),
  z.object({ kind: z.literal("unreadable"), error: z.string() }),
]);
export type ClaudeCodeStatus = z.infer<typeof ClaudeCodeStatusSchema>;

/** A status that stops an agent from starting. */
export type ClaudeCodeBlock = Exclude<ClaudeCodeStatus, { kind: "ready" }>;

/** One line saying what is wrong. */
export function claudeCodeProblem(block: ClaudeCodeBlock): string {
  switch (block.kind) {
    case "signed-out":
      return "Claude Code is not signed in";
    case "unreadable":
      return `Couldn't check Claude Code: ${block.error}`;
  }
}

/**
 * Why no agent can start, and where to fix it — a full sentence ready to show
 * in an error toast or a tooltip. The fix is a place in the app, never a
 * command: the user does not run a CLI.
 */
export function claudeCodeBlockMessage(block: ClaudeCodeBlock): string {
  const where =
    block.kind === "signed-out"
      ? " Sign in from the Claude Code row of the health report."
      : "";
  return `${claudeCodeProblem(block)}, so no agent can start.${where}`;
}

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
