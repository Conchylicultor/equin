// Whether this page could reach the network while a load ran — and waiting for
// it to again.
//
// A browser drops a page's module downloads when the page loses its reach:
// the tab is hidden (a phone freezes a backgrounded browser's network), the
// device goes offline, or the page is leaving. The import then rejects
// ("Failed to fetch dynamically imported module", WebKit's "Importing a module
// script failed") exactly as it would for a file the server failed to serve.
// equin.ai's edge access log showed it is the former: every such failure lined
// up with the visitor's browser cancelling its requests or going silent until
// QUIC's idle timeout, never with the box failing to answer (2026-11-19). A demo
// boot is ~2,700 files over a minute or two, so a visitor who switches apps
// mid-load lost the demo, and the dying load was reported as our crash.
//
// So a load that failed after the page lost its reach is the visitor's network,
// not an answer: it is asked again once the page is visible and online
// (`loadAcrossReachLoss`), never on a timer. One that fails while the page kept
// its reach throws at once — a missing file, an evaluation error, a server
// failing to serve stay as loud as before, and so does a reload that fails
// again after the page came back.
//
// Off a page (a worker, bun) there is no visibility to lose: every load keeps
// its reach and the wrapper is a plain call.

// Page-global by design: the page's visibility and connectivity are one fact
// for the whole document, observed once.
let reachLosses = 0;
let watching = false;

function onPage(): boolean {
  return typeof document !== "undefined" && typeof window !== "undefined";
}

function canFetchNow(): boolean {
  return document.visibilityState !== "hidden" && navigator.onLine;
}

function watch(): void {
  if (watching) return;
  watching = true;
  const lost = () => {
    reachLosses++;
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") lost();
  });
  // Page Lifecycle (Chromium): a frozen page's loads are cancelled.
  document.addEventListener("freeze", lost);
  window.addEventListener("offline", lost);
  window.addEventListener("pagehide", lost);
}

/** A point in the page's reach history, to ask later whether it was lost since. */
export interface ReachMark {
  readonly losses: number;
}

export function markPageReach(): ReachMark {
  if (!onPage()) return { losses: 0 };
  watch();
  return { losses: reachLosses };
}

/**
 * Did the page lose its reach since `mark` — hidden, offline, frozen or leaving
 * while the load ran? Only a loss SEEN during the load counts: a page that was
 * already offline (`navigator.onLine` is false on a laptop with Wi-Fi off, yet
 * localhost answers) keeps failing loudly instead of waiting for an `online`
 * that may never come.
 */
export function pageReachLostSince(mark: ReachMark): boolean {
  if (!onPage()) return false;
  return reachLosses !== mark.losses;
}

/**
 * Resolves once the page is visible and online — at once if it is. A page that
 * never comes back (closed, navigated away) never resolves it: nothing after it
 * runs, which is right for a load nobody will see.
 */
export function whenPageCanFetch(): Promise<void> {
  if (!onPage() || canFetchNow()) return Promise.resolve();
  return new Promise((resolve) => {
    const check = () => {
      if (!canFetchNow()) return;
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("online", check);
      window.removeEventListener("pageshow", check);
      resolve();
    };
    document.addEventListener("visibilitychange", check);
    window.addEventListener("online", check);
    window.addEventListener("pageshow", check);
  });
}

/**
 * `load()`, asked again each time it failed after the page lost its reach —
 * once the page is visible and online again. A failure while the page kept its
 * reach is thrown. Each new attempt needs a new loss of reach to be retried, so
 * this never loops on its own.
 */
export async function loadAcrossReachLoss<T>(
  load: () => Promise<T>,
): Promise<T> {
  for (;;) {
    const mark = markPageReach();
    try {
      return await load();
    } catch (err) {
      if (!pageReachLostSince(mark)) throw err;
      console.warn(
        "[plugin] a load failed while the page was hidden, offline or leaving — loading it again once the page is back",
        err,
      );
      await whenPageCanFetch();
    }
  }
}
