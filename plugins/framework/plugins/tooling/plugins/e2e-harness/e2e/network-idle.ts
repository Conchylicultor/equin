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
 * out a worker's script load (`isWorkerChunkPath`, the one place web-artifacts
 * says where it emits worker scripts: vite's worker chunks and the browser
 * hosts' worker trees).
 *
 * What a SharedWorker fetches itself is not counted: it reaches no page
 * listener, and attaching to the worker over CDP to see it keeps the worker
 * alive past its last page (see `tapSharedWorkerRequests`), which changes what a
 * returning page meets. So idle here is the PAGE's network: on /demo it comes
 * while the host is still loading in its worker. Wait on what the page shows
 * for that — a marker, or `waitForNotBusy` (no `aria-busy` loader left).
 *
 * A request the previous document left in flight is dropped when the next one
 * commits: Playwright never reports it finished.
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
  // The URL of the latest main-frame navigation: a commit landing there (or
  // on about:blank, which sends none) replaces the document.
  let navigatingTo: string | null = null;
  const isMainNavigation = (req: Request): boolean =>
    req.isNavigationRequest() && req.frame() === page.mainFrame();
  page.on("request", (req) => {
    if (isMainNavigation(req)) navigatingTo = withoutHash(req.url());
    if (isWorkerChunkPath(new URL(req.url()).pathname)) return;
    tracker.inflight.add(req);
    notify();
  });
  const settle = (req: Request): void => {
    if (tracker.inflight.delete(req)) notify();
  };
  page.on("requestfinished", settle);
  page.on("requestfailed", settle);
  // What the replaced document still had in flight is never reported finished
  // or failed — a request sent as it unloaded (a log flush) would hold every
  // wait on the next document forever. At the commit, nothing of the new
  // document has been sent yet, so every request but the navigation itself is
  // the old one's. A same-document navigation (pushState, a hash) commits
  // nothing new: it lands neither where a navigation request went nor on
  // about:blank — so a navigation that never committed (a 204, a download)
  // leaves no pending drop for the next pushState to take.
  page.on("framenavigated", (frame) => {
    if (frame !== page.mainFrame()) return;
    const url = frame.url();
    if (url !== "about:blank" && withoutHash(url) !== navigatingTo) return;
    navigatingTo = null;
    let dropped = false;
    for (const req of tracker.inflight) {
      if (isMainNavigation(req)) continue;
      tracker.inflight.delete(req);
      dropped = true;
    }
    if (dropped) notify();
  });
}

function withoutHash(url: string): string {
  const hash = url.indexOf("#");
  return hash === -1 ? url : url.slice(0, hash);
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
