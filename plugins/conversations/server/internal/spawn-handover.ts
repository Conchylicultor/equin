/**
 * The spawns that are done with their `starting` row while their job row is
 * still in the queue.
 *
 * A spawn holds its row `starting` for as long as it is in flight
 * (`PlanContext.spawnInFlight`): it starts its agent in the workspace's files
 * before the workspace is ready, and only types the launch prompt once it is.
 * Its last act is to hand the row over and ask for a reconcile — but the job
 * row it runs under is completed only after the body returns (graphile's
 * completion write lands a moment later, un-awaited), so that reconcile would
 * still read the run in flight and leave the row `starting` until the next
 * unrelated signal or the minute sweep. Marked here first, it stops counting
 * at once — the same gap `jobs`' dying-runs closes for a run's death.
 *
 * A fact about this process's own spawns, held in this process: a restart
 * forgets it, and by then the job row is complete (no longer in flight) or the
 * spawn re-runs and hands over again.
 */
const handedOver = new Set<string>();

/** The spawn of `conversationId` is done with its `starting` row. */
export function handOverStarting(conversationId: string): void {
  handedOver.add(conversationId);
}

/**
 * The spawns still holding their row `starting`: `inFlight` (the queue's
 * answer for `asked`) minus those handed over. A mark whose run the queue no
 * longer holds is forgotten, as is one whose row is no longer `starting`
 * (`settled`) — so the set holds only launches between their hand-over and
 * the reconcile that takes their row up.
 */
export function spawnsHoldingStarting(
  asked: readonly string[],
  inFlight: ReadonlySet<string>,
  settled: readonly string[],
): ReadonlySet<string> {
  for (const id of settled) handedOver.delete(id);
  for (const id of asked) if (!inFlight.has(id)) handedOver.delete(id);
  if (handedOver.size === 0) return inFlight;
  return new Set([...inFlight].filter((id) => !handedOver.has(id)));
}
