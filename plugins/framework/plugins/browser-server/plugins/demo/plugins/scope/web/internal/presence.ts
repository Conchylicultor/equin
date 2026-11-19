// Whether the visitor is already in a demo in another tab of this browser:
// every tab whose visitor is in the demo (entered at its gate, or joined)
// holds one shared Web Lock per scenario, so a tab opening the demo asks the
// browser who holds it — no message to wait an answer for, and a closed or
// crashed tab releases it by itself.

/**
 * The browser refuses this page Web Locks: Firefox and Chrome gate them on
 * site storage, so a browser blocking cookies and site data (or a sandboxed
 * frame) rejects every call with a `SecurityError`. Then no tab of this
 * browser can tell another it is in — the same as a browser without them.
 */
function locksRefused(err: unknown): boolean {
  return err instanceof DOMException && err.name === "SecurityError";
}

/** The Web Lock a tab whose visitor is in `scenarioId`'s demo holds. */
const presenceLockName = (scenarioId: string): string =>
  `demo-visitor-in ${scenarioId}`;

/**
 * Whether another tab of this browser has its visitor in `scenarioId`'s demo
 * now. Without Web Locks (a test DOM — every browser offering SharedWorker
 * offers them), or where the browser refuses them (`locksRefused`), no other
 * tab can be known: `false`, so the gate shows.
 */
export async function visitorInElsewhere(scenarioId: string): Promise<boolean> {
  if (!("locks" in navigator)) return false;
  const name = presenceLockName(scenarioId);
  try {
    const { held = [], pending = [] } = await navigator.locks.query();
    return [...held, ...pending].some((lock) => lock.name === name);
  } catch (err) {
    if (locksRefused(err)) return false;
    throw err;
  }
}

/**
 * Hold `scenarioId`'s presence lock, shared, until the returned release —
 * what {@link visitorInElsewhere} reads in another tab. Without Web Locks
 * there is nothing to hold.
 */
export function holdVisitorIn(scenarioId: string): () => void {
  if (!("locks" in navigator)) return () => undefined;
  let released = false;
  // Until the lock is granted, a release only marks it so: the grant ends at once.
  let release = (): void => undefined;
  // Refused Web Locks hold nothing, and no other tab could read a hold.
  void navigator.locks
    .request(
      presenceLockName(scenarioId),
      { mode: "shared" },
      () =>
        new Promise<void>((done) => {
          if (released) done();
          else release = done;
        }),
    )
    .catch((err: unknown) => {
      if (!locksRefused(err)) throw err;
    });
  return () => {
    released = true;
    release();
  };
}
