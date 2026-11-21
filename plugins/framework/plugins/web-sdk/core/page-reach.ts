import {
  clockOffset,
  type ClockOffset,
} from "@plugins/primitives/plugins/perfs/plugins/page-clock/core";

// Whether this page could reach the network while a load ran — and waiting for
// it to again.
//
// A browser drops a page's module downloads when the page loses its reach:
// the tab is hidden (a phone freezes a backgrounded browser's network), the
// device goes offline or to sleep, or the page is leaving. The import then rejects
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
// A sleep fires none of those events: a laptop closed with the tab in front
// stays "visible" and "online" throughout. Its requests in flight die with
// their connections (the server idles them out while the machine sleeps) and
// reject the moment it wakes. equin.ai's edge log showed exactly that for a
// Firefox visitor on /foundations (2026-11-19): the page's load stopped
// mid-way at 13:34:43, nothing for 39 minutes, then at 14:13:54 the rest of
// its chunks arrived and the shared-ws worker and an idle page-body preload
// failed — the two loads in flight when the lid closed. So a sleep is read
// from the page's two clocks instead: the wall clock runs on through it, the
// performance timeline pauses (`primitives/perfs/page-clock`), and their
// offset grows by the time asleep.
//
// A worker (the demo's in-browser server is a SharedWorker serving every tab)
// has no visibility of its own, but it does go offline and to sleep with the
// device: its `offline` events and its two clocks say so, as a page's do, so
// its loads (an icon set imported on a miss) are asked again the same way.
// Off a browser (bun) there is no reach to lose: the wrapper is a plain call.

/**
 * How far the clocks must drift apart during a load to say the device slept.
 * They agree to well under a millisecond while it is awake (a busy main thread
 * moves both); a small wall-clock correction (NTP) stays below this.
 */
const SLEEP_MIN_MS = 2_000;

// Page-global by design: the page's visibility and connectivity are one fact
// for the whole document, observed once.
let reachLosses = 0;
let watching = false;

function onPage(): boolean {
  return typeof document !== "undefined" && typeof window !== "undefined";
}

function inWorker(): boolean {
  const scope = (globalThis as { WorkerGlobalScope?: unknown })
    .WorkerGlobalScope;
  return typeof scope === "function" && globalThis instanceof scope;
}

/** A browser realm whose reach can be lost: a page, or a worker. */
function inBrowser(): boolean {
  return onPage() || inWorker();
}

function canFetchNow(): boolean {
  if (!onPage()) return navigator.onLine;
  return document.visibilityState !== "hidden" && navigator.onLine;
}

function watch(): void {
  if (watching) return;
  watching = true;
  const lost = () => {
    reachLosses++;
  };
  // A worker's global scope fires `offline` as a window does.
  globalThis.addEventListener("offline", lost);
  if (!onPage()) return;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") lost();
  });
  // Page Lifecycle (Chromium): a frozen page's loads are cancelled.
  document.addEventListener("freeze", lost);
  window.addEventListener("pagehide", lost);
}

/** A point in the page's reach history, to ask later whether it was lost since. */
export interface ReachMark {
  readonly losses: number;
  /** The page's clock offset then: it grows by every sleep since. */
  readonly offset: ClockOffset;
}

export function markPageReach(): ReachMark {
  if (!inBrowser()) return { losses: 0, offset: clockOffset() };
  watch();
  return { losses: reachLosses, offset: clockOffset() };
}

/**
 * Did the page lose its reach since `mark` — hidden, offline, frozen, asleep or
 * leaving while the load ran? Only a loss SEEN during the load counts: a page that was
 * already offline (`navigator.onLine` is false on a laptop with Wi-Fi off, yet
 * localhost answers) keeps failing loudly instead of waiting for an `online`
 * that may never come.
 */
export function pageReachLostSince(mark: ReachMark): boolean {
  if (!inBrowser()) return false;
  return (
    reachLosses !== mark.losses || clockOffset() - mark.offset >= SLEEP_MIN_MS
  );
}

/**
 * Resolves once the page is visible and online — at once if it is. A page that
 * never comes back (closed, navigated away) never resolves it: nothing after it
 * runs, which is right for a load nobody will see.
 */
export function whenPageCanFetch(): Promise<void> {
  if (!inBrowser() || canFetchNow()) return Promise.resolve();
  if (!onPage()) {
    return new Promise((resolve) => {
      const check = () => {
        if (!canFetchNow()) return;
        globalThis.removeEventListener("online", check);
        resolve();
      };
      globalThis.addEventListener("online", check);
    });
  }
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
        "[plugin] a load failed while the page was hidden, offline, asleep or leaving — loading it again once the page is back",
        err,
      );
      await whenPageCanFetch();
    }
  }
}

// --- a worker that relaunches after reach loss --------------------------------
//
// A SharedWorker's script is a load like any other: a page that loses its reach
// while the worker loads (a sleep, mostly — a laptop closed mid-boot kills the
// script's request with its connection) gets the worker's `error` event, which
// reads exactly like a script the server failed to serve or a worker that
// crashed. `loadAcrossReachLoss` cannot wrap it (a worker is not a promise:
// it errors through an event, and a relaunch is a new worker), so each
// SharedWorker a page starts goes through a `WorkerRelaunch` instead: every
// launch is marked, and the launch's error is judged against that mark.
//
// A relaunch takes a new generation, which the caller puts in the worker's
// name: Firefox hands a SharedWorker made with the failed one's name within a
// few ms of the error to the dying instance, which never loads, errors or
// answers (measured in Playwright's Firefox 159: the same name hangs at 0–1 ms,
// starts from 5 ms on; another name starts at once). Tabs that woke from the
// same sleep each relaunch once, so they still share generation 1's worker.

/** One start of a worker: the generation its name carries, and the page's reach then. */
export interface WorkerLaunch {
  /** 0 for the first launch, +1 per relaunch after a reach loss. */
  readonly generation: number;
  readonly reach: ReachMark;
}

export interface WorkerRelaunch {
  /** Mark a launch, just before the worker is constructed (name it by `generation`). */
  launch(): WorkerLaunch;
  /**
   * `launch`'s worker failed to load or crashed. After the page lost its reach
   * since that launch, `relaunch` runs once the page can fetch again — the next
   * `launch()` on a new generation — and the answer is `"relaunching"`. A
   * failure while the page kept its reach is `"failed"`: the caller fails
   * loudly. `relaunch` decides for itself whether it is still wanted (the
   * caller may have closed meanwhile).
   */
  recover(launch: WorkerLaunch, relaunch: () => void): "relaunching" | "failed";
}

/** A relaunch policy for one worker the page starts (`what` names it in the warning). */
export function createWorkerRelaunch(what: string): WorkerRelaunch {
  let generation = 0;
  return {
    launch: () => ({ generation, reach: markPageReach() }),
    recover(launch, relaunch) {
      if (!pageReachLostSince(launch.reach)) return "failed";
      console.warn(
        `${what}: the worker failed to load while the page was hidden, offline, asleep or leaving — starting it again once the page is back`,
      );
      generation = Math.max(generation, launch.generation + 1);
      void whenPageCanFetch().then(relaunch);
      return "relaunching";
    },
  };
}
