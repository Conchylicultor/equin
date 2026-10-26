/**
 * Browser-backed page read: the sibling of `safeFetch` for pages that a plain
 * HTTP client cannot read at all — either because the origin's bot mitigation
 * keys on the TLS/client fingerprint (which no header set can disguise), or
 * because the content only exists after JavaScript has run.
 *
 * Same contract as `safeFetch` in the one way that matters: a target can never
 * reach a loopback / private / link-local / metadata address. It gets there by a
 * different route — Chromium's `--host-resolver-rules` pins DNS at LAUNCH, and
 * every intercepted request is re-guarded with `parsePublicUrl` — which is why
 * this is a sub-plugin of `safe-fetch` rather than a peer.
 */
import type {
  Browser,
  Response as PlaywrightResponse,
  Request as PlaywrightRequest,
} from "playwright";
import {
  assertResolvesPublic,
  parsePublicUrl,
} from "@plugins/infra/plugins/safe-fetch/server";
import { readyNow, type Ready } from "@plugins/infra/plugins/deps/deps";
import { requestDep } from "@plugins/infra/plugins/deps/server";
import {
  launchChromium,
  type PlaywrightBrowserSource,
} from "@plugins/infra/plugins/deps/plugins/playwright-browser/deps";
import { chromium as chromiumDep } from "../../deps";
import { withDeadline } from "@plugins/packages/plugins/deadline/core";
import {
  BrowserFetchError,
  BrowserUnavailableError,
  browserInstallFailed,
  browserInstalling,
  browserUnavailable,
} from "./errors";
import { buildLaunchArgs } from "./launch-args";
import { withBrowserSlot } from "./pool";
import { decideRequest } from "./request-policy";
import { proxySubresource } from "./subresource-proxy";
import {
  resolveInit,
  type BrowserFetchInit,
  type BrowserFetchResult,
  type ResolvedInit,
} from "./types";

type PlaywrightModule = typeof import("playwright");

// Playwright costs ~1–3 s of module evaluation. A backend must never pay that at
// boot merely because something in its import graph *can* start a browser, so it
// is loaded on first use — inside a call that is already spending ~4 s on a
// launch, where it is comparatively free — and memoized for every call after.
let playwrightModule: Promise<PlaywrightModule> | undefined;

/**
 * Load Playwright, BOUNDED.
 *
 * The bound is not defensive garnish. This was the ONE unbounded `await` in the
 * whole chain: every step after it (`launch`, `goto`, the settle) takes a
 * `timeout` and enforces it, so an import that never settled left the 30 s launch
 * bound and the 45 s whole-op budget both un-armed behind it — a step that
 * answers neither "here is your page" nor "here is why you cannot have one",
 * which is precisely what this plugin's contract forbids.
 *
 * `budgetMs` comes from `stepTimeout`, so this step is clamped to what is left of
 * the whole-op budget exactly like `launch` and `goto` are, and the caller's
 * `signal` is honored before it is entered.
 */
async function loadPlaywright(
  url: string,
  budgetMs: number,
): Promise<PlaywrightModule> {
  const pending = (playwrightModule ??= import("playwright"));
  try {
    return await withDeadline(
      pending,
      budgetMs,
      () =>
        new BrowserUnavailableError(
          "launch-failed",
          url,
          `Loading the Playwright module took longer than ${Math.round(budgetMs)}ms, ` +
            `so no browser could be started for ${url}.`,
        ),
    );
  } catch (err) {
    if (err instanceof BrowserFetchError) {
      // Deliberately NOT clearing the memo when the DEADLINE fired. That import
      // is still in flight; dropping the handle would start a second concurrent
      // import of the same module and leave the first with nobody to observe it.
      // Keeping it means the next call re-races the same promise — and if the
      // module does finish, that call gets it for free.
      throw err;
    }
    // A REJECTED import must not be memoized as the answer — an operator who
    // fixes the install should not have to restart the backend to be believed.
    // Safe to clear here precisely because we are the awaiter: the promise has
    // already settled, so nothing is orphaned.
    playwrightModule = undefined;
    throw browserUnavailable(url, err);
  }
}

/**
 * Read a page with a real browser.
 *
 * **Lifecycle: one browser per call, closed in a `finally` on every path.** This
 * is settled by a security fact, not by taste. `--host-resolver-rules` is a
 * launch flag and is the only mechanism inside Chromium that pins DNS, so a warm
 * browser reused for a second host has exactly three options: resolve it with
 * Chromium's own unguarded resolver (discarding the DNS-rebinding protection
 * this plugin exists to provide), relaunch anyway (which *is* launch-per-call),
 * or grow an in-process forward proxy that re-implements the pinning logic and
 * can drift from it. The accepted cost, stated plainly: ~4.2 s of launch + close
 * on every call.
 *
 * Throws — a page that could not be read is never returned as a thin one.
 * `status` is a field on the SUCCESS value (a 404 still renders HTML; the caller
 * owns what a 404 means). `SsrfError` propagates unwrapped.
 */
export async function browserFetch(
  target: string | URL,
  init: BrowserFetchInit = {},
): Promise<BrowserFetchResult> {
  const opts = resolveInit(init);

  // Validate BEFORE pool admission: a refusal must never queue behind someone
  // else's 5-second render.
  const logicalUrl = parsePublicUrl(
    typeof target === "string" ? target : target.href,
  );
  const ip = await assertResolvesPublic(logicalUrl);

  // Also before admission: with no browser installed there is nothing to queue
  // for.
  const browser = await installedChromium(logicalUrl.href);

  return withBrowserSlot(() => renderChain(logicalUrl, ip, opts, browser));
}

/**
 * The installed Chromium, or the typed reason there is none — never a stand-in
 * page. Chromium is an on-demand dependency: this is a request path, so it
 * never installs (`readyNow` only reads), it asks for the install
 * (`requestDep` enqueues the `deps.install` job and returns at once) and says
 * `installing`. A FAILED install is not re-requested from here — every
 * browser read would otherwise start another doomed ~280 MB download.
 */
async function installedChromium(
  url: string,
): Promise<Ready<PlaywrightBrowserSource>> {
  const now = await readyNow(chromiumDep);
  switch (now.kind) {
    case "ready":
      return now.ready;
    case "failed":
      throw browserInstallFailed(url, now.message);
    case "absent":
    case "installing":
      // Requested even while `installing`: the install may be a terminal's
      // `deps install`, and the job (which waits on its host lock) is what
      // the Dependencies view follows. A second request claims nothing.
      await requestDep(chromiumDep);
      throw browserInstalling(url);
  }
}

interface HopTotals {
  launchMs: number;
  navigateMs: number;
  settleMs: number;
}

type HopResult =
  | {
      kind: "page";
      url: string;
      status: number;
      headers: Record<string, string>;
      html: string;
      inBrowserRedirects: number;
    }
  /** The main frame was sent to another host; the pin must be rebuilt for it. */
  | { kind: "cross-host"; url: string; inBrowserRedirects: number };

/**
 * The redirect loop. A same-host redirect needs nothing — `MAP` binds a hostname
 * regardless of scheme or path, so Chromium follows it inside one browser. A
 * redirect to a NEW host cannot be followed at all (the pin is a launch arg), so
 * each one costs a full revalidate + relaunch. `maxRedirects` is therefore much
 * lower than `safeFetch`'s: every hop is seconds, not milliseconds. Each hop
 * re-runs `parsePublicUrl` + `assertResolvesPublic`, matching `safeFetch`'s
 * per-hop revalidation exactly.
 */
async function renderChain(
  startUrl: URL,
  startIp: string,
  opts: ResolvedInit,
  browser: Ready<PlaywrightBrowserSource>,
): Promise<BrowserFetchResult> {
  // The whole-op clock starts HERE, after admission — a call is not charged for
  // time it spent queueing behind other renders.
  const startedAt = performance.now();
  const deadline = startedAt + opts.timeoutMs;
  const totals: HopTotals = { launchMs: 0, navigateMs: 0, settleMs: 0 };

  let url = startUrl;
  let ip = startIp;
  let redirects = 0;

  for (;;) {
    const hop = await renderOnce(url, ip, opts, deadline, totals, browser);

    if (hop.kind === "page") {
      return {
        url: hop.url,
        status: hop.status,
        headers: hop.headers,
        html: hop.html,
        redirects: redirects + hop.inBrowserRedirects,
        timings: {
          ...totals,
          totalMs: performance.now() - startedAt,
        },
      };
    }

    redirects += hop.inBrowserRedirects + 1;
    if (redirects > opts.maxRedirects) {
      throw new BrowserFetchError(
        "too-many-redirects",
        url.href,
        `Too many redirects (>${opts.maxRedirects}) loading ${startUrl.href}`,
      );
    }

    url = parsePublicUrl(hop.url);
    ip = await assertResolvesPublic(url);
  }
}

async function renderOnce(
  logicalUrl: URL,
  ip: string,
  opts: ResolvedInit,
  deadline: number,
  totals: HopTotals,
  installed: Ready<PlaywrightBrowserSource>,
): Promise<HopResult> {
  const href = logicalUrl.href;
  const pinnedHost = logicalUrl.hostname.toLowerCase();
  // Bounded like every other step, and clamped to the same whole-op deadline.
  // Loaded here, under the budget, so the import inside `launchChromium`
  // below finds the module already evaluated.
  const { errors } = await loadPlaywright(
    href,
    stepTimeout(deadline, opts, opts.launchTimeoutMs, href),
  );

  const launchStart = performance.now();
  let browser: Browser;
  try {
    browser = await launchChromium(installed, {
      args: buildLaunchArgs(pinnedHost, ip),
      timeout: stepTimeout(deadline, opts, opts.launchTimeoutMs, href),
    });
  } catch (err) {
    if (err instanceof BrowserFetchError) throw err; // the deadline fired
    throw browserUnavailable(href, err);
  }
  totals.launchMs += performance.now() - launchStart;

  try {
    const context = await browser.newContext({
      viewport: opts.viewport,
      // Nothing this browser touches may outlive the call: no service worker to
      // keep fetching, no download to land on disk. The profile is ephemeral by
      // construction (a fresh launch), so there is no persistent storage either.
      serviceWorkers: "block",
      acceptDownloads: false,
      // No `ignoreHTTPSErrors` — see `launch-args.ts`. We dial a pinned IP but
      // certificate identity stays bound to the real hostname.
    });
    const page = await context.newPage();

    // `context.route` does NOT cover WebSockets, so a page could otherwise open
    // one to a host we never pinned. Closing them immediately is the whole of the
    // policy: nothing this primitive reads arrives over a socket.
    await page.routeWebSocket("**", async (ws) => {
      await ws.close();
    });

    // Mutable hop state lives on an object rather than in `let`s: it is written
    // from route/response callbacks, and a plain local would be narrowed by
    // control-flow analysis to its initializer at every read below.
    const state = {
      crossHost: null as string | null,
      networkBytes: 0,
      budgetExceeded: false,
    };

    const chargeBytes = (bytes: number): void => {
      state.networkBytes += bytes;
      if (state.networkBytes > opts.maxNetworkBytes)
        state.budgetExceeded = true;
    };

    // Best-effort network accounting for requests Chromium makes itself: only a
    // declared `content-length` is countable without buffering the body, so a
    // chunked response with no length is invisible here. The HARD ceiling is
    // `maxHtmlBytes` on the serialized DOM; this one exists to stop a page that
    // streams gigabytes of subresources, and it is honest about being a bound on
    // what the origin declared.
    page.on("response", (res) => {
      const declared = Number(res.headers()["content-length"] ?? Number.NaN);
      if (Number.isFinite(declared)) chargeBytes(declared);
    });

    await context.route("**/*", async (route) => {
      const request = route.request();
      if (state.budgetExceeded) {
        await route.abort("blockedbyclient");
        return;
      }

      const decision = decideRequest({
        url: request.url(),
        resourceType: request.resourceType(),
        // `request.frame()` throws only for service-worker-issued requests, and
        // service workers are blocked on the context above.
        isMainFrameNavigation:
          request.isNavigationRequest() && request.frame() === page.mainFrame(),
        pinnedHost,
      });

      switch (decision.kind) {
        case "continue":
          await route.continue();
          return;
        case "block":
          await route.abort("blockedbyclient");
          return;
        case "cross-host-navigation":
          state.crossHost = decision.url;
          await route.abort("blockedbyclient");
          return;
        case "proxy": {
          const remaining = opts.maxNetworkBytes - state.networkBytes;
          const outcome = await proxySubresource(route, request, remaining);
          if (outcome.ok) chargeBytes(outcome.bytes);
          return;
        }
      }
    });

    const navStart = performance.now();
    let response: PlaywrightResponse | null;
    try {
      response = await page.goto(href, {
        // `domcontentloaded`, not `load`: `load` waits on every straggling
        // subresource, and the settle step below is the one that decides when the
        // page is done. The two together are bounded; `load` alone is not.
        waitUntil: "domcontentloaded",
        timeout: stepTimeout(deadline, opts, opts.navigationTimeoutMs, href),
      });
    } catch (err) {
      totals.navigateMs += performance.now() - navStart;
      // A blocked cross-host navigation surfaces as a failed goto. That is not an
      // error — it is the redirect, and the caller relaunches pinned to it.
      if (state.crossHost !== null) {
        return {
          kind: "cross-host",
          url: state.crossHost,
          inBrowserRedirects: 0,
        };
      }
      if (err instanceof BrowserFetchError) throw err; // the deadline fired
      if (err instanceof errors.TimeoutError) {
        throw new BrowserFetchError(
          "navigation-timeout",
          href,
          `Timed out loading ${href} in a browser`,
          { cause: err },
        );
      }
      throw new BrowserFetchError(
        "navigation-failed",
        href,
        `Could not load ${href} in a browser: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    totals.navigateMs += performance.now() - navStart;

    if (state.crossHost !== null) {
      return {
        kind: "cross-host",
        url: state.crossHost,
        inBrowserRedirects: 0,
      };
    }
    if (!response) {
      throw new BrowserFetchError(
        "navigation-failed",
        href,
        `No response for ${href} (same-document navigation?)`,
      );
    }

    const settleStart = performance.now();
    await page
      .waitForLoadState("networkidle", {
        timeout: stepTimeout(deadline, opts, opts.settleMs, href),
      })
      .catch((err: unknown) => {
        // Reaching the settle ceiling is the EXPECTED path, not a failure: a page
        // with a live poll or an open connection never goes idle. Only the
        // timeout is absorbed — anything else is a real problem and propagates.
        if (!(err instanceof errors.TimeoutError)) throw err;
      });

    if (opts.waitForSelector !== undefined) {
      try {
        await page.waitForSelector(opts.waitForSelector, {
          timeout: stepTimeout(deadline, opts, opts.settleMs, href),
        });
      } catch (err) {
        if (err instanceof BrowserFetchError) throw err; // the deadline fired
        if (err instanceof errors.TimeoutError) {
          throw new BrowserFetchError(
            "selector-timeout",
            href,
            `Selector ${opts.waitForSelector} never appeared on ${href}`,
            { cause: err },
          );
        }
        throw err;
      }
    }
    totals.settleMs += performance.now() - settleStart;

    if (state.budgetExceeded) {
      throw new BrowserFetchError(
        "network-budget-exceeded",
        href,
        `${href} requested more than ${opts.maxNetworkBytes} bytes of subresources`,
      );
    }

    const html = await page.content();
    const bytes = Buffer.byteLength(html, "utf8");
    if (bytes > opts.maxHtmlBytes) {
      // Deliberately a throw, not a truncation. A short page carrying a 200 is
      // indistinguishable downstream from a site that genuinely has nothing on
      // it, and that mistake is destructive in a way a loud failure never is.
      throw new BrowserFetchError(
        "html-too-large",
        href,
        `${href} rendered ${bytes} bytes of HTML, over the ${opts.maxHtmlBytes} byte cap. ` +
          `Refusing to return a truncated page.`,
      );
    }

    return {
      kind: "page",
      url: page.url(),
      status: response.status(),
      // Playwright lowercases header names, matching the result contract.
      headers: response.headers(),
      html,
      inBrowserRedirects: countRedirects(response.request()),
    };
  } finally {
    // Every path — success, throw, cross-host redirect — closes the browser. A
    // leaked Chromium is ~400 MB of the host's memory held by nobody.
    await browser.close();
  }
}

/** How many same-host redirects Chromium followed inside this one browser. */
function countRedirects(request: PlaywrightRequest): number {
  let hops = 0;
  for (
    let prev = request.redirectedFrom();
    prev !== null;
    prev = prev.redirectedFrom()
  ) {
    hops++;
  }
  return hops;
}

/**
 * A step's timeout, clamped to what is left of the whole-op budget, and the one
 * place the caller's `signal` is honored. Playwright takes no `AbortSignal`, so
 * abort is enforced at step boundaries — never mid-navigation, but always before
 * committing to another multi-second wait.
 */
function stepTimeout(
  deadline: number,
  opts: ResolvedInit,
  stepMs: number,
  url: string,
): number {
  if (opts.signal?.aborted === true) {
    throw new BrowserFetchError("aborted", url, `Aborted while loading ${url}`);
  }
  const remaining = deadline - performance.now();
  if (remaining <= 0) {
    throw new BrowserFetchError(
      "aborted",
      url,
      `Exceeded the ${opts.timeoutMs}ms budget loading ${url}`,
    );
  }
  return Math.min(stepMs, remaining);
}
