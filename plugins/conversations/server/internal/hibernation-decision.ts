/**
 * What to do with a DB row whose live process is missing.
 * - `"hibernate"`: resumable row not yet hibernated → stamp `hibernatedAt`.
 * - `"leave-hibernated"`: resumable row already hibernated → leave alone.
 * - `"leave-unowned"`: not this runtime's row to classify (non-main) → no write.
 * - `"gone"`: nothing to resume (no `claudeSessionId`) → mark disconnected.
 *
 * A MISSING PROCESS NEVER CHANGES STATUS. An agent process is an internal
 * resource detail: idle ones are stopped to reclaim resources and transparently
 * respawned by `ensureResumed` when the user opens the conversation. A `waiting`
 * row stays `waiting` when its agent disappears — only an explicit close (`exit_clean` /
 * the UI's Exit, via `closeRequested` → `markConversationClosed`) moves a
 * conversation to a terminal status. (The reconciler separately settles a
 * `working` row to `waiting`, since nothing computes without a process — see
 * `planAbsent`; that is never a terminal status, so none of the below applies.)
 *
 * WHY THIS MATTERS BEYOND THE UI — writing `gone` from process absence deleted
 * users' work. `gone` is simultaneously:
 *   - the RESUMABLE state: `resumeConversation` refuses any row that is not
 *     `gone`/`done`, so `gone` is what makes a conversation resumable; and
 *   - the NOT-LIVE state: `has_live_conv = status NOT IN ('gone','done')` feeds
 *     `attempts_v.active`, which is the worktree reaper's `if (attempt.active)
 *     return null` guard.
 * So the moment a vanished agent wrote `gone`, the conversation was marked
 * resumable and its git worktree became collectable in the same write. A reboot
 * or a killed agent process while an agent was mid-turn was enough to get a live
 * conversation's checkout reaped out from under it.
 *
 * The old shape had this inverted: hibernation was a narrow exception
 * (`onMain && hibernationEnabled && status === "waiting" && claudeSessionId`)
 * and EVERYTHING else fell through to `gone`. Now hibernation is the rule and
 * `gone` is the narrow exception.
 *
 * Note the signature cannot read `status` at all. That is deliberate: the
 * invariant "process absence does not depend on, or alter, conversation status"
 * is enforced by the type rather than by discipline.
 *
 * Eligibility is deliberately SEPARATE from the re-stamp guard (`hibernatedAt`).
 * An already-hibernated row stays eligible and must be left untouched — its
 * process is intentionally absent forever, so folding `!hibernatedAt` into
 * eligibility would flip every hibernated conversation on the next reconcile.
 */
export type MissingProcessAction =
  "hibernate" | "leave-hibernated" | "leave-unowned" | "gone";

export function decideMissingProcessAction(
  row: { claudeSessionId: string | null; hibernatedAt: Date | null },
  opts: { onMain: boolean },
): MissingProcessAction {
  // Conversation rows are owned by main. Each worktree's forked DB holds stale
  // copies of rows it did not spawn, whose agents it cannot see (agent paths
  // are per namespace). A non-main reconciler classifying those would write
  // `gone` into its fork for conversations that are alive elsewhere — the same
  // mislabelling, just scoped to one fork.
  if (!opts.onMain) return "leave-unowned";

  // Resumable ⇒ hibernated, whatever the status was and whatever the
  // hibernation config says. `hibernationConfig.enabled` gates the PROACTIVE
  // idle-kill job (`conversations.hibernate-idle`) — whether we go looking for
  // agents to reclaim. It must not decide what we do with an agent we have already
  // found missing: turning the config off must not convert "reclaim resources"
  // into "lose the conversation".
  if (row.claudeSessionId)
    return row.hibernatedAt ? "leave-hibernated" : "hibernate";

  // The one honest `gone`: no Claude session id means no transcript to resume
  // from, so there is genuinely nothing to come back to. Narrow on purpose —
  // this is the only path from process absence to a status write.
  return "gone";
}
