/**
 * What to do when the field's external `value` and the local draft disagree.
 *
 * - `echo` — the external value IS the last thing we saved (or the seed). This
 *   is our own write coming back; there is nothing new.
 * - `stale` — the external value is one this field has already LEFT BEHIND:
 *   the value it started from, or one it saved before its latest save. Nothing
 *   but a stale echo of our own past spells it — a prediction retired before
 *   the server's frame landed, a late frame, a refetch racing a write, a tab on
 *   an older bundle. Adopting it would put deleted text back and move the
 *   caret, so it is ignored: the next view of the source supersedes it.
 * - `adopt` — the external value moved on and the draft carries no unsaved
 *   edits, so taking it loses nothing. This is the common case, and the one the
 *   hook used to DROP whenever the field happened to have focus.
 * - `converged` — the draft already spells the external value (the user typed
 *   their way to it, or a save is racing an identical write). Nothing to
 *   replace; just record that the two sides agree.
 * - `conflict` — the external value moved on AND the draft carries unsaved
 *   edits. Neither side can be discarded silently: the draft stays on screen
 *   and the divergence is reported.
 */
export type Reconciliation =
  "echo" | "stale" | "adopt" | "converged" | "conflict";

/**
 * The reconcile policy, as a pure function of what decides it: what the source
 * says now (`external`), what is on screen (`draft`), what this field last put
 * on the source (`lastSaved`), and the values it has left behind (`past` — its
 * starting value and every earlier save, since the last value it adopted from
 * elsewhere). Divergence is exactly `draft !== lastSaved` — the user has typed
 * something no save has taken yet.
 *
 * `stale` is decided BEFORE `converged`: a draft that happens to spell an old
 * value of ours (typed back to it, unsaved) must not be marked as saved by a
 * stale echo of that value, or the next save would be skipped and the source
 * would keep the newer one.
 */
export function reconcile<T extends string>(
  external: T,
  draft: T,
  lastSaved: T,
  past: ReadonlySet<T>,
): Reconciliation {
  if (Object.is(external, lastSaved)) return "echo";
  if (past.has(external)) return "stale";
  if (Object.is(draft, lastSaved)) return "adopt";
  if (Object.is(draft, external)) return "converged";
  return "conflict";
}
