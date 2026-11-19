// Background loads: what a page downloads on its own, ahead of any ask —
// the code of pages it is not showing (`lazyComponent`'s `preload: "idle"`),
// a video's metadata before anyone pressed play. Worth having when the
// network is idle; on a slow link, competition for the one thing the visitor
// is now waiting on.
//
// A hold says "the visitor asked for this download and is watching it come
// in" (the live demo's Enter: ~10 MB they wait for). While any hold is taken,
// a background load that has not started yet waits; once the last is
// released, every waiting one starts. A load already in flight is never
// recalled — the browser offers no way to cancel a module fetch — so the
// hold only keeps NEW background work off the link.

const holds = new Set<symbol>();
const waiting: Array<() => void> = [];
const listeners = new Set<() => void>();

/**
 * Take a hold: background loads not started yet wait until it is released
 * (and every other hold with it). Returns the release, safe to call twice —
 * an effect's cleanup.
 */
export function holdBackgroundLoads(): () => void {
  const hold = Symbol("background-loads hold");
  holds.add(hold);
  if (holds.size === 1) for (const l of listeners) l();
  return () => {
    if (!holds.delete(hold) || holds.size > 0) return;
    for (const l of listeners) l();
    for (const start of waiting.splice(0)) start();
  };
}

/** Whether a hold is taken right now: a background load would wait. */
export function backgroundLoadsHeld(): boolean {
  return holds.size > 0;
}

/**
 * Hear when holds start or stop (`useSyncExternalStore`'s subscribe, with
 * {@link backgroundLoadsHeld} as the snapshot). Returns the unsubscribe.
 */
export function subscribeBackgroundLoads(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Run `start` — a background load — now, or once no hold is left. */
export function startBackgroundLoad(start: () => void): void {
  if (holds.size === 0) start();
  else waiting.push(start);
}
