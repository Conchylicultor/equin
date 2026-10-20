import type { BrowserContext, Page, Request } from "playwright";
import { isWorkerChunkPath } from "@plugins/framework/plugins/tooling/plugins/web-artifacts/core";

/**
 * Network-idle as the harness measures it — Playwright's own `networkidle`
 * never fires on this app.
 *
 * The live sockets run in a SharedWorker (networking's `SharedWebSocket`).
 * Playwright reports the worker's script load as a request of the page that
 * started it, but the response lands in the worker's target, which Playwright
 * does not attach to — so the request never finishes and `networkidle` waits
 * forever. This tracker counts the page's in-flight requests itself and leaves
 * out a worker-chunk load (`isWorkerChunkPath`, the one place web-artifacts
 * emits worker scripts).
 *
 * Every page a harness session creates is tracked from its first request (the
 * session's page, and any `context.newPage()` after it); `waitForNetworkIdle`
 * refuses a page the harness never saw.
 */

interface Tracker {
  inflight: Set<Request>;
  /** Wakes the waiters whenever the in-flight set changes. */
  changed: Set<() => void>;
}

const trackers = new WeakMap<Page, Tracker>();

function track(page: Page): void {
  if (trackers.has(page)) return;
  const tracker: Tracker = { inflight: new Set(), changed: new Set() };
  trackers.set(page, tracker);
  const notify = (): void => {
    for (const fn of [...tracker.changed]) fn();
  };
  page.on("request", (req) => {
    if (isWorkerChunkPath(new URL(req.url()).pathname)) return;
    tracker.inflight.add(req);
    notify();
  });
  const settle = (req: Request): void => {
    if (tracker.inflight.delete(req)) notify();
  };
  page.on("requestfinished", settle);
  page.on("requestfailed", settle);
}

/** Track every page of a harness session's context, from its first request. */
export function trackContextNetwork(context: BrowserContext): void {
  context.on("page", track);
  for (const page of context.pages()) track(page);
}

/**
 * The URLs `page` has in flight right now (worker loads aside) — what a timed-out
 * wait prints, so "still loading" names what it was still loading. `null` for a
 * page no harness session created (its requests were never tracked).
 */
export function inflightUrls(page: Page): string[] | null {
  const tracker = trackers.get(page);
  return tracker ? [...tracker.inflight].map((r) => r.url()) : null;
}

export interface NetworkIdleOptions {
  timeoutMs?: number;
  /** How long the page must stay without an in-flight request (Playwright's own rule: 500ms). */
  idleMs?: number;
}

/** Resolve once `page` has had no in-flight request (worker loads aside) for `idleMs`. */
export async function waitForNetworkIdle(
  page: Page,
  opts: NetworkIdleOptions = {},
): Promise<void> {
  const tracker = trackers.get(page);
  if (!tracker) {
    throw new Error(
      "waitForNetworkIdle: this page was not created by a harness session, so " +
        "its requests were never tracked — create it with h.session() or its " +
        "context's newPage().",
    );
  }
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const idleMs = opts.idleMs ?? 500;
  await new Promise<void>((resolve, reject) => {
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const deadline = setTimeout(() => {
      done();
      const pending = [...tracker.inflight].map((r) => r.url());
      reject(
        new Error(
          `waitForNetworkIdle: still ${pending.length} request(s) in flight after ` +
            `${timeoutMs}ms: ${pending.slice(0, 5).join(", ")}`,
        ),
      );
    }, timeoutMs);
    const check = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
      if (tracker.inflight.size > 0) return;
      idleTimer = setTimeout(() => {
        done();
        resolve();
      }, idleMs);
    };
    const done = (): void => {
      clearTimeout(deadline);
      if (idleTimer) clearTimeout(idleTimer);
      tracker.changed.delete(check);
    };
    tracker.changed.add(check);
    check();
  });
}
