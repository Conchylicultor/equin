/**
 * Browser + context lifecycle for e2e scripts.
 *
 * `chromium.launch()` and `{ viewport: { width: 1400, height: 900 } }` appeared
 * verbatim in 23 of the 29 pre-move scripts, and the two-context convergence
 * tests repeated the whole context+page+error-listener block once for A and once
 * for B. None of them closed the browser in a `finally`, so any mid-script throw
 * leaked a Chromium process — `withBrowser` fixes that for every caller at once.
 */
import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import { ensureDepViaCli, type Ready } from "@plugins/infra/plugins/deps/deps";
import {
  connectChromium,
  launchChromium,
  type PlaywrightBrowserSource,
} from "@plugins/infra/plugins/deps/plugins/playwright-browser/deps";
import { readBrowserExecutables } from "@plugins/infra/plugins/deps/plugins/playwright-browser/core";
import { chromium } from "@plugins/infra/plugins/safe-fetch/plugins/browser-fetch/deps";
import {
  agentOriginHeaders,
  ORIGIN_HEADER,
  ORIGIN_SOURCE_HEADER,
} from "@plugins/infra/plugins/request-origin/core";
import {
  decodeAttachTicket,
  type AttachTicket,
} from "@plugins/infra/plugins/mcp/plugins/browser/core";
import { arg, flag, usage } from "./args";
import { capture, type Captured } from "./capture";
import { detectOsColorScheme, type ColorScheme } from "./color-scheme";
import { onBeforeFinish } from "./report";
import { createRecorder } from "./recorder";
import { repairAgentWrites, settleAgentWrites } from "./agent-writes";
import { assertDeployIdentity } from "./deploy-identity";
import { isTargetOrigin, targetNamespace, unconsumedPage } from "./target";
import { trackContextNetwork, waitForNetworkIdle } from "./network-idle";
import { describeBootStall } from "./boot-diagnosis";
import { ELEMENT_TIMEOUT_MS } from "./wait";

export const DEFAULT_VIEWPORT = { width: 1400, height: 900 } as const;

/**
 * The running script, as a provenance label: `plugins/…/copy-paste-verify.ts`
 * → `"e2e:copy-paste-verify"`. Derived from argv rather than passed in — a
 * per-script argument is one more thing to remember, and the one that gets
 * forgotten is the one that leaks a page into the user's sidebar.
 */
function originSource(): string {
  const entry = process.argv[1];
  if (!entry) return "e2e";
  return `e2e:${basename(entry).replace(/\.[tj]sx?$/, "")}`;
}

export interface SessionOptions {
  viewport?: { width: number; height: number };
  /** Defaults to the host OS appearance so screenshots match what the user sees. */
  colorScheme?: ColorScheme;
  /** Prefix for captured-error lines, e.g. "A" / "B" in a convergence test. */
  label?: string;
  /** Set false to skip the pageerror/console/requestfailed listeners. */
  capture?: boolean;
}

export interface Session {
  context: BrowserContext;
  page: Page;
  captured: Captured;
  label: string;
}

export interface Harness {
  browser: Browser;
  /** A fresh context + page (own cookies, own storage, own websocket). */
  session(opts?: SessionOptions): Promise<Session>;
}

/**
 * One probe, reported inline. Every line of the diagnostic below is best-effort
 * by nature — we are already on an error path, and a probe that cannot answer
 * must not replace the launch failure with its own. So a failed probe returns
 * the reason it failed AS ITS VALUE: the line still appears, still says
 * something true, and the original error is still what gets thrown.
 */
function probe(what: () => string): string {
  try {
    return what();
  } catch (err) {
    return `<unavailable: ${err instanceof Error ? err.message : String(err)}>`;
  }
}

/**
 * Read a package's version through the SAME module graph the launch used —
 * `Bun.resolveSync` from `from`, not a hardcoded `node_modules` path.
 *
 * That distinction is the whole point of this function. Module resolution walks
 * UP the directory tree, and every worktree lives under the main checkout, so a
 * worktree with no `node_modules` of its own silently resolves the MAIN
 * checkout's playwright — a different version, pinning a different chromium
 * revision, with nothing on screen to say so.
 */
function packageVersion(
  spec: string,
  from: string,
): { path: string; version: string } {
  const pkgPath = Bun.resolveSync(`${spec}/package.json`, from);
  const { version } = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    version?: string;
  };
  return { path: pkgPath, version: version ?? "<no version field>" };
}

/**
 * Why a launch failure is re-thrown rather than left to Playwright.
 *
 * Playwright's own message names ONE fact — the executable path it wanted —
 * which reads like "run the installer" and is a dead end when the real cause
 * is WHICH playwright ran: a module resolved from somewhere the repo never
 * chose (a worktree with no `node_modules` of its own resolves the MAIN
 * checkout's, a different version with nothing on screen to say so). So the
 * diagnostic names the playwright that ran, where it resolved from, and the
 * executables the Chromium install recorded (as Playwright reported them when
 * it installed them) — the pair this launch picked between.
 */
function launchFailure(
  cause: unknown,
  installed: Ready<PlaywrightBrowserSource>,
): Error {
  const here = import.meta.dir;
  const playwright = probe(() => {
    const { path, version } = packageVersion("playwright", here);
    return `${version}  (${path})`;
  });
  const core = probe(() => {
    // Resolved FROM the playwright package's own directory: playwright-core is
    // playwright's nested dependency, so it is not resolvable from the repo
    // root. It carries the browser revision pin, which is why it is named here
    // separately rather than assumed equal to playwright's own version.
    const pkg = Bun.resolveSync("playwright/package.json", here);
    const { path, version } = packageVersion("playwright-core", dirname(pkg));
    return `${version}  (${path})`;
  });
  const recorded = readBrowserExecutables(installed.dir);
  const executables = recorded.ok
    ? `headless ${recorded.executables.headlessShell}\n` +
      `                  headed   ${recorded.executables.headed}\n` +
      `                  (installed for playwright-core ${recorded.executables.playwrightCore})`
    : `<unreadable: ${recorded.reason}>`;
  const detail = cause instanceof Error ? cause.message : String(cause);

  return new Error(
    `Playwright could not launch chromium.\n` +
      `  playwright      ${playwright}\n` +
      `  playwright-core ${core}\n` +
      `  install         ${installed.dir}\n` +
      `  executables     ${executables}\n` +
      `  launch error    ${detail}\n` +
      `\n` +
      `If the resolved path above is NOT inside this checkout, the script ran against\n` +
      `another checkout's dependencies. Run it as \`./singularity run <script.ts> [args…]\`,\n` +
      `which installs this worktree's own node_modules from its own lock first. If the\n` +
      `install itself is damaged: \`./singularity deps remove chromium\`, then run again.`,
    { cause },
  );
}

/**
 * Fail the run when the caller named a page the script never opened.
 *
 * The target URL's path is only meaningful to a tool whose job is "open the
 * page I name" (`screenshot.ts`, `perf.ts`, the profilers) — those call
 * `pageUrl()`. A script that verifies one specific screen names it itself, so
 * `tabs-verify.ts --url http://wt:9000/pages` would drive `/agents` and pass,
 * having tested a screen the caller did not ask for. Nothing crashes: the
 * origin was split off correctly, so only the intent is lost. That is exactly
 * the silent green run this harness exists to make unreachable.
 *
 * Runs at teardown, not at launch: a script may read its page inside the
 * `withBrowser` callback (three `adaptive-bar` scripts do), which has not run
 * when the browser starts, so a launch-time check would fail correct scripts.
 */
function assertPageWasConsumed(): void {
  const page = unconsumedPage();
  if (page === undefined) return;
  throw new Error(
    `the target URL named a page (${page}) but this script drives its own.\n` +
      `  Drop the path to point it at another deploy: --url http://<worktree>.localhost:9000`,
  );
}

/**
 * The agent-origin headers reach the app and nothing else.
 *
 * `extraHTTPHeaders` is context-wide: Chromium stamps the two headers on EVERY
 * request the page makes, third parties included. A custom header makes a
 * cross-origin fetch non-simple, so the browser preflights it — and Google
 * Fonts, unpkg, any CDN a prototype loads from, answers the preflight without
 * `x-singularity-origin` in `Access-Control-Allow-Headers`. The font never
 * loads, the page renders in a fallback face, and a picture of it compares
 * against nothing real. Nothing off the target deploy reads these headers, so
 * they are stripped from every request that leaves it. Same-origin requests
 * are untouched — including ones a script stalls with `stallRoute`, whose
 * page-level handler runs first and never reaches this route.
 */
async function keepOriginHeadersOnTarget(
  context: BrowserContext,
): Promise<void> {
  await context.route(
    (url) => !isTargetOrigin(url.toString()),
    async (route) => {
      const headers = { ...route.request().headers() };
      delete headers[ORIGIN_HEADER];
      delete headers[ORIGIN_SOURCE_HEADER];
      await route.continue({ headers });
    },
  );
}

/**
 * Launch chromium, run `fn`, and always close the browser. `--headed` on the
 * command line opens a visible window, which is the one thing every script
 * author reaches for when a flow misbehaves.
 *
 * The single choke point for browser lifecycle across all 125 per-plugin
 * scripts, which is why the launch diagnostic lives here and nowhere else.
 */
export async function withBrowser<T>(
  fn: (h: Harness) => Promise<T>,
): Promise<T> {
  // PROVE THE DEPLOY FIRST — before the repair below, not after it, and that
  // order is the highest-value half of this whole check. `repairAgentWrites`
  // POSTs to the RESOLVED ORIGIN, so while the target was derived from a
  // directory name every browser script run from a worktree agent session began
  // by reverting the user's live config documents on MAIN. A refusal has to land
  // before the first request, not before the first assertion.
  await assertDeployIdentity();

  const attach = arg("attach");
  if (attach !== undefined) return withAttachedBrowser(attach, fn);

  // START REPAIR, before the browser exists. A previous run killed by Ctrl-C, a
  // SIGKILL or a Playwright timeout never reached its own revert, and its ledger
  // is still on disk — so this is the half no teardown can provide, and the
  // reason the poisoned-baseline bug cannot come back: every baseline this run
  // reads is taken after the user's real config has been restored.
  //
  // On the normal path, not in a `finally`, so `process.exit` cannot skip it.
  await repairAgentWrites("start");

  // Chromium is an on-demand dependency: the first run on a machine installs
  // it (~280 MB, progress on this terminal) in a `./singularity deps install`
  // child — this script holds no ExecContext of its own — and every run after
  // finds it with one read.
  const installed = await ensureDepViaCli(chromium, {
    stdio: "inherit",
    grant: null,
  });

  let browser: Browser;
  try {
    // Headless runs the recorded chrome-headless-shell, `--headed` the headed
    // binary of the same revision.
    browser = await launchChromium(installed, { headless: !flag("headed") });
  } catch (err) {
    throw launchFailure(err, installed);
  }

  // Every run is recorded: each API call the script makes is a step, filmed
  // at full resolution, filed under the Bash tool call that launched the
  // script, so the conversation view shows the steps under that call. The
  // environment names only that transcript row — never the deploy to drive.
  // `--no-record` opts out, for a script whose timings the screencast would
  // skew (a profiler).
  const recorder = flag("no-record")
    ? null
    : createRecorder(browser, process.argv[1] ?? "e2e", process.env);

  let torndown = false;
  const teardown = async (): Promise<void> => {
    if (torndown) return;
    torndown = true;
    // The screencasts are stopped through the open pages, so the recording is
    // written before anything closes. Its failure is re-thrown at the end:
    // it must not skip the close and the revert below.
    const recording = await (recorder?.finish() ?? Promise.resolve()).then(
      () => null,
      (err: unknown) => ({ err }),
    );
    // ORDER IS LOAD-BEARING. Close first: a pending DataView write lives in a
    // `setTimeout` inside the page, so closing the context kills the timer and
    // bounds what can still reach the server to what is already dispatched.
    // Then drain those. Only then revert, or the revert races a write.
    await browser.close();
    await settleAgentWrites();
    await repairAgentWrites("end");
    assertPageWasConsumed();
    if (recording !== null) throw recording.err;
  };

  // `finish()` ends in `process.exit()`, which skips `finally` — and 86 of the
  // 136 scripts here call `finish()` INSIDE this callback. So the `finally`
  // below is not reachable for most of the fleet, and registering the teardown
  // is what makes it run for them. (That is also why `browser.close()` moved in
  // here: it was being skipped for those same scripts, leaking a Chromium
  // process per run, despite this file's docblock claiming otherwise.)
  const release = onBeforeFinish(teardown);

  try {
    return await fn({
      browser,
      async session(opts: SessionOptions = {}): Promise<Session> {
        const context = await browser.newContext({
          viewport: opts.viewport ?? { ...DEFAULT_VIEWPORT },
          colorScheme: opts.colorScheme ?? detectOsColorScheme(),
          // Provenance, declared once for the whole harness. `extraHTTPHeaders`
          // applies to EVERY request the context issues — including the SPA's
          // own `fetch` calls — so this single line marks all existing scripts,
          // every future script, and ad-hoc `screenshot.ts --click` drives, with
          // nothing to opt into and nothing to remember. Server-side the mark
          // drives two things: the agent-origin plugin turns it into a swept,
          // segregated page, and every agent-write ledger (config documents,
          // prototype option picks, …) records what a marked request
          // overwrites so this harness can put it back (see `agent-writes.ts`).
          // research/2026-07-29-global-agent-origin-provenance-for-pages.md
          // research/2026-09-16-global-shared-prototype-option-picks.md
          extraHTTPHeaders: agentOriginHeaders(originSource()),
        });
        await keepOriginHeadersOnTarget(context);
        // Before the first page, so every page is filmed from its first paint.
        recorder?.attach(context);
        // Before the first page, so every page is tracked from its first
        // request (see `network-idle.ts`).
        trackContextNetwork(context);
        const page = await context.newPage();
        const label = opts.label ?? "";
        return {
          context,
          page,
          label,
          captured:
            opts.capture === false
              ? { pageErrors: [], consoleErrors: [], failedRequests: [] }
              : capture(page, opts.label),
        };
      },
    });
  } finally {
    // Deregister first: whichever path fires, the teardown runs exactly once.
    release();
    await teardown();
  }
}

/**
 * `--attach <ticket>`: run inside a conversation's agent-browser session
 * (`infra/mcp/browser`) instead of a browser of our own, and leave the tab
 * there — so when the script fails at step N, the agent continues from that
 * exact page with the browser_* tools rather than replaying the whole flow.
 *
 * The ticket (from the `browser_attach` MCP tool) names the session browser's
 * `bind()` pipe and the tab it opened for us. Connections to that pipe share
 * every context and leave them open on disconnect, so this drives a page the
 * backend owns, under the session's own headers and cookies, and `close()`
 * only drops our connection.
 *
 * What it skips, and why:
 *  - no install / launch: the browser is the session's;
 *  - no agent-write repair or settle, at either end: the writes belong to the
 *    session, whose close reverts the same ledger — and reverting at start
 *    would wipe the interactive state the agent is deliberately continuing
 *    from. The baseline is the session's, not a clean one;
 *  - one session only: a second context would outlive the script in the
 *    shared browser, owned by nobody.
 */
async function withAttachedBrowser<T>(
  raw: string,
  fn: (h: Harness) => Promise<T>,
): Promise<T> {
  if (raw === "") usage("--attach needs the ticket browser_attach returned.");
  if (flag("headed")) {
    usage(
      "--attach drives the agent's shared headless browser; drop --headed.",
    );
  }
  const ticket = decodeAttachTicket(raw);
  if (!isTargetOrigin(ticket.origin)) {
    throw new Error(
      `--attach: the ticket's session drives ${ticket.origin}, but this run targets ${targetNamespace()}.\n` +
        `  Ask browser_attach from the conversation whose checkout this is, or drop --attach.`,
    );
  }
  assertSamePlaywright(ticket);

  let browser: Browser;
  try {
    browser = await connectChromium(ticket.endpoint);
  } catch (err) {
    throw new Error(
      `--attach: could not reach the agent browser at ${ticket.endpoint} ` +
        `(${err instanceof Error ? err.message : String(err)}).\n` +
        `  It restarted or went idle since the ticket was issued — ask browser_attach for a new one.`,
      { cause: err },
    );
  }
  const page = browser
    .contexts()
    .flatMap((c) => c.pages())
    .find((p) => p.url() === ticket.marker);
  if (!page) {
    await browser.close();
    throw new Error(
      `--attach: tab ${ticket.tab} is no longer waiting at its ticket ` +
        `(closed, navigated, or the ticket was already used) — ask browser_attach for a new one.`,
    );
  }

  // Recorded like a launched run: the ticket's tab, and any page the script
  // opens in its context, filed under the Bash call that ran the script.
  const recorder = flag("no-record")
    ? null
    : createRecorder(browser, process.argv[1] ?? "e2e", process.env);

  let torndown = false;
  const teardown = async (): Promise<void> => {
    if (torndown) return;
    torndown = true;
    // The screencasts are stopped through the connection, so before it drops;
    // a failure is re-thrown once it has.
    const recording = await (recorder?.finish() ?? Promise.resolve()).then(
      () => null,
      (err: unknown) => ({ err }),
    );
    const at = page.isClosed() ? "closed by the script" : page.url();
    // Drops this connection only: the tab and its session stay up.
    await browser.close();
    console.log(
      `[e2e] kept tab ${ticket.tab} in the conversation's browser session (${at}) — ` +
        `continue with browser_read_page({ tab: "${ticket.tab}" })`,
    );
    assertPageWasConsumed();
    if (recording !== null) throw recording.err;
  };
  const release = onBeforeFinish(teardown);

  let handedOut = false;
  try {
    return await fn({
      browser,
      async session(opts: SessionOptions = {}): Promise<Session> {
        if (handedOut) {
          throw new Error(
            "--attach drives ONE session (the ticket's tab), and this script opens another. Run it without --attach.",
          );
        }
        handedOut = true;
        await page.setViewportSize(opts.viewport ?? { ...DEFAULT_VIEWPORT });
        await page.emulateMedia({
          colorScheme: opts.colorScheme ?? detectOsColorScheme(),
        });
        const context = page.context();
        recorder?.attach(context);
        recorder?.film(page);
        trackContextNetwork(context);
        const label = opts.label ?? "";
        return {
          context,
          page,
          label,
          captured:
            opts.capture === false
              ? { pageErrors: [], consoleErrors: [], failedRequests: [] }
              : capture(page, opts.label),
        };
      },
    });
  } finally {
    release();
    await teardown();
  }
}

/**
 * `connect` speaks the binder's protocol version: refuse a mismatch with both
 * versions named (main's backend can lag a worktree's Playwright upgrade)
 * rather than let it surface as a protocol error.
 */
function assertSamePlaywright(ticket: AttachTicket): void {
  const ours = packageVersion("playwright", import.meta.dir).version;
  const minor = (v: string) => v.split(".").slice(0, 2).join(".");
  if (minor(ours) === minor(ticket.playwright)) return;
  throw new Error(
    `--attach: this checkout runs playwright ${ours}, the agent browser ${ticket.playwright} — ` +
      `they cannot connect. Run without --attach until both sides are on one version.`,
  );
}

export interface BootOptions {
  /** A selector that proves the app actually rendered. */
  marker?: string;
  /**
   * How long to wait for `marker` (default `ELEMENT_TIMEOUT_MS`, the measured
   * budget for an element the app has to render — the first navigation after
   * a deploy is the loaded case), or for load when no marker (default 30 s).
   */
  timeoutMs?: number;
  /**
   * What this app can say about its own state, appended to the diagnosis a
   * marker timeout throws (e.g. which of its frames exist, in which status).
   */
  describe?: (page: Page) => Promise<string>;
  /** A final fixed pause after the marker appears, for post-paint hydration. */
  settleMs?: number;
}

/**
 * Navigate and wait for the app to be genuinely ready.
 *
 * The pre-move scripts almost all used `goto` + `waitForTimeout(4000)`. A fixed
 * sleep is the single largest flake source here: on a cold backend the app can
 * take longer than the sleep (the script then reads an empty DOM and reports a
 * false failure), and on a warm one it wastes four seconds per navigation. Two
 * scripts had already independently reinvented a polling settle; this is that,
 * shared. `marker` keeps it app-agnostic — the harness never names a selector
 * belonging to any particular app.
 */
export async function boot(
  page: Page,
  url: string,
  opts: BootOptions = {},
): Promise<void> {
  const loadMs = opts.timeoutMs ?? 30_000;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: loadMs });
  if (opts.marker) {
    await waitForMarker(
      page,
      opts.marker,
      opts.timeoutMs ?? ELEMENT_TIMEOUT_MS,
      opts.describe,
    );
  } else {
    // Not Playwright's `networkidle`: it never fires on this app (a
    // SharedWorker's script load never finishes as far as the page can see).
    await waitForNetworkIdle(page, { timeoutMs: loadMs });
  }
  if (opts.settleMs) await page.waitForTimeout(opts.settleMs);
}

/**
 * Wait for `marker` to be visible; on a timeout, throw what the page was
 * showing instead (`describeBootStall`) — a bare "waitFor timed out" cannot
 * tell a slow cold boot from a page stuck on something else.
 */
async function waitForMarker(
  page: Page,
  marker: string,
  timeoutMs: number,
  describe: BootOptions["describe"],
): Promise<void> {
  try {
    await page
      .locator(marker)
      .first()
      .waitFor({ state: "visible", timeout: timeoutMs });
  } catch (err) {
    if (!(err instanceof Error) || err.name !== "TimeoutError") throw err;
    const seen = await describeBootStall(page, marker, describe).catch(
      (diagErr: unknown) => [
        `(could not read the page: ${diagErr instanceof Error ? diagErr.message : String(diagErr)})`,
      ],
    );
    throw new Error(
      `boot: ${marker} not visible after ${String(timeoutMs)}ms\n  ${seen.join("\n  ")}`,
      { cause: err },
    );
  }
}
