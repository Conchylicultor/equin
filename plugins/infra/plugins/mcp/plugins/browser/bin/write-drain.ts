import type { BrowserContext, Request } from "playwright";

/**
 * The writes a session still has on the wire, so closing it reverts only once
 * they have landed.
 *
 * Closing a context aborts its requests on the CLIENT side only: a POST that
 * was already sent still reaches the server and is applied, and a revert run
 * before it lands undoes everything but that write, which then sticks in the
 * user's data. The harness covers the same race by polling the ledger until
 * it stops changing; the host knows exactly which requests are outstanding,
 * so it waits for those instead.
 *
 * A request counts from the context's own `request` event: tracking starts
 * when the session opens, because the in-flight write this exists for was
 * sent before anyone asked to close. Context-level events also cover pages an
 * attached script opened through `bind()`.
 */

/** Methods that cannot write. Everything else may. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export type DrainOutcome =
  { kind: "drained" } | { kind: "timeout"; pending: string[] };

export interface WriteDrain {
  /**
   * Stop the context sending anything new, then wait for every tracked write
   * already sent to get its response — at most `timeoutMs`. A response means
   * the server's handler ran, so its ledger entry is recorded.
   */
  drain(timeoutMs: number): Promise<DrainOutcome>;
}

/** The pure half: a set of outstanding requests and who waits for it to empty. */
export function createInFlight<K>(): {
  add(key: K): void;
  remove(key: K): void;
  pending(): K[];
  /** Resolves `true` once nothing is outstanding, `false` after `timeoutMs`. */
  whenEmpty(timeoutMs: number): Promise<boolean>;
} {
  const outstanding = new Set<K>();
  const waiters = new Set<() => void>();
  return {
    add: (key) => void outstanding.add(key),
    remove(key) {
      if (!outstanding.delete(key) || outstanding.size > 0) return;
      for (const wake of waiters) wake();
    },
    pending: () => [...outstanding],
    whenEmpty(timeoutMs) {
      if (outstanding.size === 0) return Promise.resolve(true);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          waiters.delete(wake);
          resolve(false);
        }, timeoutMs);
        const wake = () => {
          clearTimeout(timer);
          waiters.delete(wake);
          resolve(true);
        };
        waiters.add(wake);
      });
    },
  };
}

/** Track `context`'s writes to every origin `tracked` accepts. */
export function trackWrites(
  context: BrowserContext,
  tracked: (url: URL) => boolean,
): WriteDrain {
  const inFlight = createInFlight<Request>();
  context.on("request", (req) => {
    if (SAFE_METHODS.has(req.method())) return;
    if (tracked(new URL(req.url()))) inFlight.add(req);
  });
  context.on("requestfinished", (req) => inFlight.remove(req));
  context.on("requestfailed", (req) => inFlight.remove(req));
  return {
    async drain(timeoutMs) {
      // Later routes win, so this one sees every request from here on — a
      // debounced write-back whose timer fires mid-drain included.
      await context.route("**/*", (route) => route.abort("blockedbyclient"));
      if (await inFlight.whenEmpty(timeoutMs)) return { kind: "drained" };
      return {
        kind: "timeout",
        pending: inFlight.pending().map((r) => `${r.method()} ${r.url()}`),
      };
    },
  };
}
