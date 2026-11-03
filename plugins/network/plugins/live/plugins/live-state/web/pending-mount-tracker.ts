// How many mounted `useResource` reads are still waiting for their first value.
//
// This is the page-wide answer to "is what the user just opened on screen yet?":
// a page load or an in-app navigation is over when this count is back to zero and
// stays there. Each `useResource` holds one count from mount until its first value
// lands (or it unmounts), through the release function `notePendingMount` returns —
// an effect cleanup, so StrictMode's mount → cleanup → mount cannot double-count.
//
// live-state stays policy-free: it counts, and a consumer (debug/latency-ledger)
// decides what an interaction is and when it ended. A listener set rather than a
// report sink because a sink holds ONE handler, and this is a level (a count) that
// several readers may watch, not an event stream with an owner.

export interface PendingMountSnapshot {
  /** Mounted reads with no value yet. */
  pending: number;
  /** Reads that have EVER started waiting — monotonic, so a consumer can count
   *  how many an interaction mounted by subtracting two snapshots. */
  startedTotal: number;
  /** Resource key of the read that most recently got its value (or unmounted). */
  lastReleasedKey: string | null;
  /** Keys still waiting, most-waited first, a handful at most — for a diagnostic
   *  line when a screen never finishes loading. */
  pendingKeys: string[];
}

let pending = 0;
let startedTotal = 0;
let lastReleasedKey: string | null = null;
const pendingByKey = new Map<string, number>();
const MAX_PENDING_KEYS = 8;
const listeners = new Set<(pending: number) => void>();

function snapshot(): PendingMountSnapshot {
  const pendingKeys = [...pendingByKey.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_PENDING_KEYS)
    .map(([key, n]) => (n > 1 ? `${key}×${n}` : key));
  return { pending, startedTotal, lastReleasedKey, pendingKeys };
}

// Listeners get the bare count: this runs twice per mounted read (a few hundred
// times per page load), and only a diagnostic line ever wants the full snapshot.
function emit(): void {
  for (const listener of listeners) listener(pending);
}

/** Count one read as waiting. The returned release is idempotent. */
export function notePendingMount(key: string): () => void {
  pending += 1;
  startedTotal += 1;
  pendingByKey.set(key, (pendingByKey.get(key) ?? 0) + 1);
  emit();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    pending -= 1;
    lastReleasedKey = key;
    const left = (pendingByKey.get(key) ?? 1) - 1;
    if (left > 0) pendingByKey.set(key, left);
    else pendingByKey.delete(key);
    emit();
  };
}

export function pendingMountSnapshot(): PendingMountSnapshot {
  return snapshot();
}

/** Called with the new count on every change. Returns the unsubscribe. */
export function subscribePendingMounts(
  listener: (pending: number) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
