import { z } from "zod";
import { wholeList } from "@plugins/packages/plugins/list-bound/core";

/**
 * Can this machine run an agent right now? Every agent — and every one-shot
 * generation — is an Agent SDK session on the user's own Claude Code, so the
 * answer is whether it is installed and signed in.
 *
 * - `ready`      — installed and signed in.
 * - `signed-out` — installed, but its initialize answer names no credential.
 * - `missing`    — no executable where it is looked for (`searched`).
 * - `unreadable` — the check itself failed (timed out, crashed, printed
 *                  something that is not its JSON). Not a verdict on Claude
 *                  Code: the app cannot tell, and says so.
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
  z.object({
    kind: z.literal("missing"),
    searched: wholeList(z.string(), {
      reason: "the few places the CLI is looked for — a fixed handful of paths",
    }),
  }),
  z.object({ kind: z.literal("unreadable"), error: z.string() }),
]);
export type ClaudeCodeStatus = z.infer<typeof ClaudeCodeStatusSchema>;

/** A status that stops an agent from starting. */
export type ClaudeCodeBlock = Exclude<ClaudeCodeStatus, { kind: "ready" }>;

/**
 * The commands that fix each blocking state — the one spelling shared by the
 * launch refusal, the health row and the tooltip. doctor.sh prints the same two
 * lines (framework/cli/plugins/doctor); status.test.ts keeps them in step.
 */
export const CLAUDE_CODE_FIX = {
  install: "curl -fsSL https://claude.ai/install.sh | bash",
  signIn: "claude auth login",
} as const;

/** The fix commands for a blocking state, in the order to run them. */
export function claudeCodeFixCommands(block: ClaudeCodeBlock): string[] {
  switch (block.kind) {
    case "missing":
      return [CLAUDE_CODE_FIX.install, CLAUDE_CODE_FIX.signIn];
    case "signed-out":
      return [CLAUDE_CODE_FIX.signIn];
    case "unreadable":
      return [];
  }
}

/** One line saying what is wrong, without the fix. */
export function claudeCodeProblem(block: ClaudeCodeBlock): string {
  switch (block.kind) {
    case "missing":
      return "Claude Code is not installed";
    case "signed-out":
      return "Claude Code is not signed in";
    case "unreadable":
      return `Couldn't check Claude Code: ${block.error}`;
  }
}

/**
 * Why no agent can start, with the fix — a full sentence ready to show in an
 * error toast or a tooltip.
 */
export function claudeCodeBlockMessage(block: ClaudeCodeBlock): string {
  const fix = claudeCodeFixCommands(block);
  const run =
    fix.length === 0
      ? ""
      : ` Run \`${fix.join("` then `")}\` in a terminal, then try again.`;
  return `${claudeCodeProblem(block)}, so no agent can start.${run}`;
}
