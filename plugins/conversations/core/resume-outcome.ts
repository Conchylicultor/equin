import { z } from "zod";

/**
 * Why a conversation cannot be resumed right now.
 *
 * - `workspace-missing` — the directory the session must run in is gone (a
 *   worktree's checkout, a scratch workspace's dir). The on-disk transcript
 *   survives; the message, written by the workspace kind, says how to bring the
 *   directory back, so this is never a reason to consider the conversation over.
 * - `no-session` — no Claude session id was ever persisted, so there is no
 *   transcript for `claude --resume` to reattach to.
 * - `claude-code-unavailable` — Claude Code is not installed or not signed in
 *   on this machine, so no session can run. Repairable from a terminal; the
 *   message carries the command.
 */
export const ResumeBlockedReasonSchema = z.enum([
  "workspace-missing",
  "no-session",
  "claude-code-unavailable",
]);
export type ResumeBlockedReason = z.infer<typeof ResumeBlockedReasonSchema>;

/**
 * The outcome of a transparent (hibernation) resume attempt.
 *
 * A discriminated union rather than a bare `{ ok: true }`, because "there was
 * nothing to resume" and "this could not be resumed" are different answers that
 * the caller renders differently. Collapsing them is what let a failed
 * auto-resume pass for success: the browser fires this on every conversation
 * open and the endpoint reported `{ ok: true }` unconditionally, so a
 * conversation whose worktree had been reclaimed silently booted its agent in
 * `$HOME` with nothing surfaced to the user.
 *
 * The `blocked` arm never carries a status change with it — a conversation that
 * cannot be resumed stays exactly as it was (hibernated, still active, still
 * listed), because being temporarily unresumable is not the same as being done.
 */
export const ResumeOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("not-hibernated") }),
  z.object({ kind: z.literal("resumed") }),
  z.object({
    kind: z.literal("blocked"),
    reason: ResumeBlockedReasonSchema,
    message: z.string(),
  }),
]);
export type ResumeOutcome = z.infer<typeof ResumeOutcomeSchema>;

/** The `blocked` arm on its own — what a preflight check returns when it refuses. */
export type ResumeBlocked = Extract<ResumeOutcome, { kind: "blocked" }>;
