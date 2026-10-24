import { pathToFileURL } from "node:url";
import type { Browser } from "playwright";
import type { Ready } from "@plugins/infra/plugins/deps/deps";
import {
  launchChromium,
  type PlaywrightBrowserSource,
} from "@plugins/infra/plugins/deps/plugins/playwright-browser/deps";
import { prototypesDir } from "@plugins/apps/plugins/prototypes/data-dirs";
import {
  viewportRenderSize,
  type PrototypeMeta,
} from "@plugins/apps/plugins/prototypes/plugins/files/core";
import { classifyRenderOutcome } from "./decide";
import { ThumbnailRenderError } from "./errors";

/** Bound on one `chromium.launch()`. */
const LAUNCH_TIMEOUT_MS = 30_000;
/** Bound on reaching `load` for the prototype's own document. */
const NAV_TIMEOUT_MS = 20_000;
/** Ceiling on waiting for the network to go quiet. NOT a failure — see below. */
const SETTLE_TIMEOUT_MS = 3_000;
/** How long the page gets to paint something before we call it blank. */
const CONTENT_TIMEOUT_MS = 5_000;
/** Bound on Playwright's own module evaluation (~3 s cold on this box). */
const MODULE_TIMEOUT_MS = 30_000;
/** Bound on the browser handing back a fresh, empty context. */
const CONTEXT_TIMEOUT_MS = 15_000;
/** Bound on that context handing back its first page. */
const PAGE_TIMEOUT_MS = 15_000;
/** Bound on capturing the PNG, once the page is judged worth capturing. */
const SCREENSHOT_TIMEOUT_MS = 15_000;
/** Bound on tearing the browser down — see `closeBrowser`. */
const CLOSE_TIMEOUT_MS = 10_000;

/**
 * Render at half density: a 1440×900 prototype yields a 720×450 PNG. The
 * viewport stays at the prototype's declared CSS size (so its media queries see
 * what their author intended) and only the raster density drops — which is how
 * a card-sized image comes out of this with no image-resizing dependency.
 */
const DEVICE_SCALE_FACTOR = 0.5;

/**
 * Resource types whose failure invalidates the picture. A prototype loads React
 * and Babel from a CDN, so an offline machine renders a real page that shows
 * none of the prototype — the exact false-success that must never be cached. A
 * failed image or font is not in this set: the layout it belongs to still
 * rendered.
 */
const CRITICAL_RESOURCE_TYPES = new Set(["document", "script", "stylesheet"]);

/**
 * True when the page has painted something: any text, or any of the elements a
 * purely graphical prototype would draw into.
 *
 * A string, not a function, deliberately — it is evaluated in the browser, and
 * writing it as a string keeps DOM globals out of this server-side module.
 */
const HAS_CONTENT_EXPR = `(() => {
  const body = document.body;
  if (!body) return false;
  if ((body.innerText || "").trim().length > 0) return true;
  return body.querySelector("canvas, svg, img, video") !== null;
})()`;

type PlaywrightModule = typeof import("playwright");
let playwrightModule: Promise<PlaywrightModule> | undefined;

/**
 * Load Playwright lazily and once, BOUNDED. Importing it costs seconds of
 * module evaluation, which a backend must never pay at boot merely because
 * something in its graph *can* start a browser — the same care `browser-fetch`
 * takes. Loaded here, under the bound, so the import inside `launchChromium`
 * finds it already evaluated.
 */
async function loadPlaywright(): Promise<PlaywrightModule> {
  const pending = (playwrightModule ??= import("playwright"));
  return withTimeout(
    pending,
    MODULE_TIMEOUT_MS,
    () =>
      new ThumbnailRenderError(
        "browser-unavailable",
        `playwright did not load within ${MODULE_TIMEOUT_MS}ms`,
      ),
  );
}

/** Bound a promise that has no timeout option of its own. */
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => Error,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(onTimeout()), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Playwright signals every one of its own budget breaches this way. */
function isTimeout(err: unknown): boolean {
  return err instanceof Error && err.name === "TimeoutError";
}

/**
 * Tear the browser down without ever waiting on it forever.
 *
 * This is the call that wedged main's job queue on 2026-08-17: `close()` never
 * returned, so the handler held its worker slot until the backend restarted.
 * Every other bound in this file guards work we are waiting *for*; this one
 * guards the cleanup after it, which is exactly the one nobody thinks about.
 *
 * It never changes the verdict, in either direction. By the time it runs the
 * PNG is already captured and trustworthy, or a classified failure is already
 * unwinding — so a slow teardown is evidence about the browser, never about the
 * picture, and rethrowing here would either fail a good render or bury the
 * classified error under a teardown one.
 *
 * There is nothing left to kill on the other side of that timeout: Playwright's
 * `Browser` exposes no process handle (only the `BrowserServer` that
 * `launchServer()` hands out does), and a `close()` that does not answer means
 * chromium is already gone — as it was on the 17th, where no chromium process
 * was alive by the time the wedge was diagnosed — or unresponsive. Stated
 * plainly: an unresponsive-but-alive chromium survives here, until Playwright's
 * own exit handlers kill it when this backend restarts. That is a smaller,
 * self-clearing problem than a permanently lost worker slot.
 */
async function closeBrowser(browser: Browser, name: string): Promise<void> {
  try {
    await withTimeout(
      browser.close(),
      CLOSE_TIMEOUT_MS,
      () =>
        new Error(
          `browser.close() did not return within ${CLOSE_TIMEOUT_MS}ms`,
        ),
    );
    // eslint-disable-next-line promise-safety/no-bare-catch -- best-effort teardown: see above, propagating from here can only corrupt a verdict that is already decided
  } catch (err) {
    console.error(
      `[prototype-thumbnails] ${name}: browser teardown failed, chromium may have survived it: ${String(err)}`,
    );
  }
}

/**
 * Render one prototype to a PNG.
 *
 * Throws — with a classified `kind` — rather than ever returning a picture it
 * does not trust. The caller turns that into a visible `failed` state on the
 * card; nothing is written to the cache.
 *
 * Only ever one browser at a time, but that is the job's business, not this
 * function's: `prototypes.render-thumbnail` declares `serial: true`, so the
 * queue never hands out a second render while one is running.
 *
 * Every `await` below is bounded. That is not tidiness — this runs inside a job
 * handler, and an unbounded wait there holds a worker slot for as long as it
 * lasts.
 *
 * It never INSTALLS. It takes the installed Chromium's `Ready`, which only
 * the dependency engine mints: the job finds it with `readyNow` and, when it
 * is not there yet, asks for the install and parks the card in
 * `waiting-for-browser` (see `jobs.ts`). This once opened with
 * `ensureChromium()`, which downloaded ~150 MB synchronously on the backend's
 * event loop; taking a `Ready` makes that unspellable.
 */
export async function renderThumbnail(
  meta: PrototypeMeta,
  installed: Ready<PlaywrightBrowserSource>,
): Promise<Uint8Array> {
  await loadPlaywright();

  let browser: Browser | undefined;
  try {
    browser = await launchChromium(installed, {
      // The non-SSRF subset of browser-fetch's argv: no telemetry, no
      // variations, no component updates — none of which a local file needs,
      // and each of which is startup latency. The sandbox stays ON: a
      // prototype is arbitrary third-party JS running in the user's account.
      args: [
        "--disable-background-networking",
        "--no-first-run",
        "--disable-sync",
        "--disable-component-update",
        "--js-flags=--max-old-space-size=512",
      ],
      timeout: LAUNCH_TIMEOUT_MS,
    });
  } catch (err) {
    throw new ThumbnailRenderError(
      "browser-unavailable",
      `could not launch chromium (if its install is damaged, ` +
        `\`./equin deps install chromium\` reinstalls it): ${String(err)}`,
      { cause: err },
    );
  }

  try {
    // Neither of these two takes a timeout of its own, so both are bounded by
    // hand. A browser that launched but will not hand back a page is a broken
    // browser, not a broken prototype — hence `browser-unavailable`.
    // A `window` or `responsive` prototype has no size of its own to render
    // at here; it renders at the headless preset's.
    const size = viewportRenderSize(meta.viewport);
    const context = await withTimeout(
      browser.newContext({
        viewport: { width: size.w, height: size.h },
        deviceScaleFactor: DEVICE_SCALE_FACTOR,
        serviceWorkers: "block",
        acceptDownloads: false,
      }),
      CONTEXT_TIMEOUT_MS,
      () =>
        new ThumbnailRenderError(
          "browser-unavailable",
          `chromium did not open a context within ${CONTEXT_TIMEOUT_MS}ms`,
        ),
    );
    const page = await withTimeout(
      context.newPage(),
      PAGE_TIMEOUT_MS,
      () =>
        new ThumbnailRenderError(
          "browser-unavailable",
          `chromium did not open a page within ${PAGE_TIMEOUT_MS}ms`,
        ),
    );

    const failedCritical: string[] = [];
    page.on("requestfailed", (request) => {
      if (!CRITICAL_RESOURCE_TYPES.has(request.resourceType())) return;
      const reason = request.failure()?.errorText ?? "unknown error";
      failedCritical.push(`${request.url()} (${reason})`);
    });

    // `file://`, not the HTTP route: a prototype renders off disk by
    // contract, so this needs no gateway, no socket, and no server round-trip
    // — and it is the same path a human gets by double-clicking the file.
    const url = pathToFileURL(prototypesDir.file(meta.name, "index.html")).href;

    try {
      await page.goto(url, { waitUntil: "load", timeout: NAV_TIMEOUT_MS });
    } catch (err) {
      if (!isTimeout(err)) throw err;
      throw new ThumbnailRenderError(
        "render-timeout",
        `${meta.name} did not finish loading within ${NAV_TIMEOUT_MS}ms`,
        { cause: err },
      );
    }

    // The settle ceiling is the EXPECTED path, not a failure: a page holding
    // an open connection never goes idle, and it has still rendered.
    try {
      await page.waitForLoadState("networkidle", {
        timeout: SETTLE_TIMEOUT_MS,
      });
    } catch (err) {
      if (!isTimeout(err)) throw err;
    }

    // Waiting for content and detecting a blank page are the same act: this
    // gives an in-browser Babel compile time to produce a first paint, and
    // its timeout IS the blankness verdict.
    let painted = true;
    try {
      await page.waitForFunction(HAS_CONTENT_EXPR, undefined, {
        timeout: CONTENT_TIMEOUT_MS,
      });
    } catch (err) {
      if (!isTimeout(err)) throw err;
      painted = false;
    }

    const rejection = classifyRenderOutcome(meta.name, failedCritical, painted);
    if (rejection) throw rejection;

    // Playwright would apply its own default here; say the number out loud
    // instead, so this file holds every bound the render is subject to. A
    // capture that times out yields nothing — a half-painted PNG is
    // indistinguishable from a finished one, and that is the picture we must
    // never cache.
    try {
      const png = await page.screenshot({
        type: "png",
        timeout: SCREENSHOT_TIMEOUT_MS,
      });
      return new Uint8Array(png);
    } catch (err) {
      if (!isTimeout(err)) throw err;
      throw new ThumbnailRenderError(
        "render-timeout",
        `${meta.name} did not produce a screenshot within ${SCREENSHOT_TIMEOUT_MS}ms`,
        { cause: err },
      );
    }
  } finally {
    await closeBrowser(browser, meta.name);
  }
}
