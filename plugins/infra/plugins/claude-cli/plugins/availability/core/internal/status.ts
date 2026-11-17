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
 * - `sign-in-refused` — a credential is there, but Claude refused it: an
 *                  agent on the computer's login had a turn fail with
 *                  `authentication_failed` (an expired or revoked login).
 *                  `initialize` only says a credential is present, so the
 *                  probe alone would read `ready`; the refusal holds until
 *                  the user signs in again or asks to check again.
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
  z.object({ kind: z.literal("sign-in-refused"), version: z.string() }),
  z.object({ kind: z.literal("unreadable"), error: z.string() }),
]);
export type ClaudeCodeStatus = z.infer<typeof ClaudeCodeStatusSchema>;

/** A status that stops an agent from starting. */
export type ClaudeCodeBlock = Exclude<ClaudeCodeStatus, { kind: "ready" }>;

/**
 * What fixes a block — the action every surface showing one must offer
 * (`claude-cli/sign-in`'s `ClaudeCodeFix` draws it):
 *
 * - `sign-in` — sign in to Claude, in the app (never a command), then Check
 *   again;
 * - `check-again` — the check itself failed: ask again.
 */
export type ClaudeCodeFix = "sign-in" | "check-again";

export function claudeCodeFix(block: ClaudeCodeBlock): ClaudeCodeFix {
  switch (block.kind) {
    case "signed-out":
    case "sign-in-refused":
      return "sign-in";
    case "unreadable":
      return "check-again";
  }
}

/** One line saying what is wrong. */
export function claudeCodeProblem(block: ClaudeCodeBlock): string {
  switch (block.kind) {
    case "signed-out":
      return "Claude Code is not signed in";
    case "sign-in-refused":
      return "Claude refused this computer's sign-in (it may have expired)";
    case "unreadable":
      return `Couldn't check Claude Code: ${block.error}`;
  }
}

/**
 * Why no agent can start — a full sentence for a server answer (a refused
 * launch's 409, a failed start, a blocked resume). It names no place to fix
 * it: a surface showing a block draws its fix (`ClaudeCodeFix`), never a
 * sentence pointing elsewhere.
 */
export function claudeCodeBlockMessage(block: ClaudeCodeBlock): string {
  return `${claudeCodeProblem(block)}, so no agent can start.`;
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
