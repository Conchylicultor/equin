// ── The Web Locks API, only where it exists ─────────────────────────────────
//
// `navigator.locks` is in every browser of the floor, but not in every
// context: iOS Lockdown Mode, some in-app webviews, an insecure or opaque
// origin and some worker kinds have no `navigator.locks` at all, and a bare
// `navigator.locks.request(…)` there throws "undefined is not an object"
// (equin.ai's demo worker on Safari, report-1795088221-b1uksj). So locking is
// reachable only through `webLocks()`: its `unsupported` arm carries no lock
// manager, so a caller must branch — and decide what it does when no other
// context can be coordinated with.
//
// A browser that HAS them may still refuse a page (Firefox and Chrome gate
// them on site storage: a browser blocking site data, a sandboxed frame) —
// every call then rejects with a `SecurityError`: `locksRefused(err)`.
//
// The `web-locks/no-raw-navigator-locks` lint rule sends every other read of
// `navigator.locks` here.

/** What this context (a page or a worker) can do about Web Locks. */
export type WebLocks =
  | {
      /** No `navigator.locks` here: nothing can be held, nothing queried. */
      kind: "unsupported";
    }
  | { kind: "supported"; locks: LockManager };

const UNSUPPORTED: WebLocks = { kind: "unsupported" };

/** The API as a context may (not) carry it: lib.dom declares it always there. */
type MaybeLocksNavigator = { locks?: LockManager };

/**
 * Whether `nav` (default: this context's — a page's, or the worker's this
 * runs in) has Web Locks, and its lock manager. A host with no `navigator`
 * at all (a static render) or none with `locks` (Bun) answers `unsupported`.
 * Read at call time: cheap, and a test DOM that stubs `navigator.locks` is
 * answered as it stubbed it.
 */
export function webLocks(
  nav: MaybeLocksNavigator | undefined = (
    globalThis as { navigator?: MaybeLocksNavigator }
  ).navigator,
): WebLocks {
  const locks = nav?.locks;
  if (
    locks === undefined ||
    locks === null ||
    typeof locks.request !== "function"
  )
    return UNSUPPORTED;
  return { kind: "supported", locks };
}

/**
 * The browser has Web Locks but refuses this context them: Firefox and Chrome
 * gate them on site storage, so a browser blocking cookies and site data (or a
 * sandboxed frame) rejects every call with a `SecurityError`.
 */
export function locksRefused(err: unknown): boolean {
  return (
    typeof DOMException !== "undefined" &&
    err instanceof DOMException &&
    err.name === "SecurityError"
  );
}
