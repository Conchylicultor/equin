/**
 * The launches running INLINE in this backend — a fork into an existing
 * attempt (`finishConversation`), a resume or rewind (`respawnResume`), a
 * hibernation resume (`ensureResumed`): every launch whose `runtime.create` is
 * awaited in a request or a job body rather than in the durable spawn job.
 *
 * It is how the status sweep tells "still coming" from "never coming" for such
 * a row, as a fact rather than a clock: held from BEFORE the row turns
 * `starting` (or is stamped `resumingSince`) until the create — and the
 * failure write its catch makes — has settled. The record lives in this
 * process, and so does the create: a backend that dies mid-create takes both
 * with it, so an empty record is never stale. Every launch of a row runs in
 * the backend that reconciles it (one backend per namespace).
 *
 * Replaces `STARTING_TIMEOUT_MS`, a 30 s grace that read a slow launch as a
 * dead one.
 */
const held = new Map<string, number>();
/**
 * Every hold and release ticks the clock and stamps the row with it, so a
 * reader can ask "held at any point since my mark?" — the reconciler reads
 * its rows BEFORE these facts, and a launch that settled in between (its
 * catch already restored the row) must not be planned from the stale row.
 */
let clock = 0;
const touchedAt = new Map<string, number>();

function touch(conversationId: string): void {
  touchedAt.set(conversationId, ++clock);
}

/** Run `fn` with `conversationId` held as launching inline (re-entrant). */
export async function withInlineLaunch<T>(
  conversationId: string,
  fn: () => Promise<T>,
): Promise<T> {
  held.set(conversationId, (held.get(conversationId) ?? 0) + 1);
  touch(conversationId);
  try {
    return await fn();
  } finally {
    const n = (held.get(conversationId) ?? 1) - 1;
    if (n === 0) held.delete(conversationId);
    else held.set(conversationId, n);
    touch(conversationId);
  }
}

/** A mark to take BEFORE reading the rows {@link inlineLaunchesInFlight} judges. */
export function inlineLaunchMark(): number {
  return clock;
}

/**
 * Of `ids`, the ones with an inline launch running in this process now, or
 * held at any point since `since` (a {@link inlineLaunchMark} taken before
 * the rows were read): either way the row read may not be the launch's last
 * word, so it is not this round's to settle.
 */
export function inlineLaunchesInFlight(
  ids: readonly string[],
  since: number,
): ReadonlySet<string> {
  return new Set(
    ids.filter((id) => held.has(id) || (touchedAt.get(id) ?? 0) > since),
  );
}

/** Forget the stamps no mark can still ask about (`before`: the oldest live mark). */
export function pruneInlineLaunchStamps(before: number): void {
  for (const [id, at] of touchedAt) {
    if (at <= before && !held.has(id)) touchedAt.delete(id);
  }
}
