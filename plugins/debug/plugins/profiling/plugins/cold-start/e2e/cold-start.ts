// Cold-start benchmark: page request → first screen with data, on a stopped
// worktree server, split across the gateway, the server's boot phases and the
// browser's boot trace. See this plugin's CLAUDE.md for what each number means.
//
// Usage:
//   ./singularity run plugins/debug/plugins/profiling/plugins/cold-start/e2e/cold-start.ts \
//     [--iterations 5] [--path /agents] [--busy N] [--out /tmp/cold-start.json] \
//     [--no-stop] [--timeout 120000] [--code-cache] [--cpu-profile] [--react-profile]
//
// --busy N   N CPU-spinning children at background priority for the whole run
//            (standing in for agent builds); always killed at the end.
// --timeout  per-iteration budget for the page to reach route content; an
//            iteration that runs out keeps and prints whatever it reached.
// --no-stop  WARM run: skips the stop, so the server is already up and its boot
//            phases belong to an earlier boot (printed without a timeline offset).
// --code-cache  DIAGNOSTIC: one browser context whose HTTP cache a first load
//            fills with the app's code; every iteration still stops the server
//            and clears all browser-side storage, so only code is cached. Never
//            the headline number (see CLAUDE.md).
// --cpu-profile  record a Chromium trace with V8's sampler per iteration and
//            split the main thread's self time by code file per boot window
//            (P rows); with --out, each trace is written next to it.
// --react-profile  run debug/render-profiler from the moment its API is
//            installed (before first data) to route content, and print which
//            component and hook started each commit. Its fiber walk slows the
//            page: read counts, not times.

import { cpus, loadavg } from "node:os";
import type { Subprocess } from "bun";
import {
  agentFetch,
  DEFAULT_VIEWPORT,
  detectOsColorScheme,
  flag,
  numArg,
  arg,
  onBeforeFinish,
  pageUrl,
  report,
  targetNamespace,
  usage,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { backgroundArgv } from "@plugins/packages/plugins/spawn-priority/core";
import {
  BOOT_PLUGIN_TIMING_PREFIX,
  BOOT_TIMING_PREFIX,
  DEFERRED_LOAD_COMPLETE_ID,
  FIRST_DATA_COMMIT_ID,
  ROUTE_CONTENT_COMMIT_ID,
} from "@plugins/primitives/plugins/perfs/plugins/boot-trace/core";
import type {
  BootPluginLoadDetail,
  BootTimingDetail,
} from "@plugins/primitives/plugins/perfs/plugins/boot-trace/core";
import { SLOT_READ_TIMING_PREFIX } from "@plugins/framework/plugins/web-sdk/core";
import type { SlotReadDetail } from "@plugins/framework/plugins/web-sdk/core";
import {
  formatProfilerReport,
  RENDER_PROFILER_GLOBAL,
} from "@plugins/debug/plugins/render-profiler/core";
import type {
  ProfilerReport,
  ProfilerStartOptions,
} from "@plugins/debug/plugins/render-profiler/core";
import { ProfilingDataSchema } from "@plugins/debug/plugins/profiling/plugins/boot/core";
import type { ProfilingData } from "@plugins/debug/plugins/profiling/plugins/boot/core";
import type { BrowserContext, Page } from "playwright";
import { browserTrack } from "./browser-track";
import { CPU_TRACE_CATEGORIES, summariseCpuTrace } from "./cpu-profile";
import type { CpuWindow } from "./cpu-profile";
import type { BrowserTrack, BrowserTrackInput } from "./browser-track";

// The page-side accumulators the init script fills: long tasks from the very
// start of the load, and when each React commit happened. Declared here so the
// augmentation travels with the module.
declare global {
  interface Window {
    __coldStartLongTasks?: { startMs: number; durationMs: number }[];
    __coldStartCommits?: number[];
  }
}

const iterations = numArg("iterations", 5);
const busy = numArg("busy", 0);
const timeoutMs = numArg("timeout", 120_000);
const out = arg("out");
const warm = flag("no-stop");
const codeCache = flag("code-cache");
const cpuProfile = flag("cpu-profile");
const reactProfile = flag("react-profile");
const url = pageUrl("/agents");
const namespace = targetNamespace();
if (!Number.isInteger(iterations) || iterations < 1)
  usage(`--iterations expects a positive integer, got ${iterations}`);
if (!Number.isInteger(busy) || busy < 0)
  usage(`--busy expects a non-negative integer, got ${busy}`);

if (codeCache && warm)
  usage("--code-cache measures a cold server with cached code; drop --no-stop");

// A code-cached run is a diagnostic, never the headline: its label rides on
// the header and the SUMMARY line so it cannot be read as one.
const DIAGNOSTIC = "DIAGNOSTIC: code cached";
const r = report(
  `cold-start ${warm ? "(WARM — server not stopped)" : codeCache ? `(${DIAGNOSTIC})` : ""}`,
);

// Before the spinners start: the host as the run found it.
const loadStart = loadavg();

// --- Busy load ------------------------------------------------------------------

const spinners: Subprocess[] = [];
function killSpinners(): void {
  for (const s of spinners.splice(0)) s.kill("SIGKILL");
}
if (busy > 0) {
  for (let i = 0; i < busy; i++) {
    spinners.push(
      Bun.spawn(backgroundArgv([process.execPath, "-e", "for(;;){}"]), {
        stdio: ["ignore", "ignore", "ignore"],
      }),
    );
  }
  // Every exit path: finish() runs the before-finish hooks, a crash or a
  // usage() exit reaches "exit", Ctrl-C reaches SIGINT.
  onBeforeFinish(async () => killSpinners());
  process.on("exit", killSpinners);
  process.on("SIGINT", () => {
    killSpinners();
    process.exit(130);
  });
}

// --- One iteration ----------------------------------------------------------------

/** One boot User Timing entry, as read from the page (startTime on the page clock). */
interface TimingEntry {
  id: string;
  kind: "mark" | "measure";
  startMs: number;
  durationMs: number;
  detail: BootTimingDetail;
}

interface PageTimings {
  /** Epoch ms of the page's navigation start — the timeline's zero. */
  timeOrigin: number;
  responseStartMs: number | null;
  domContentLoadedMs: number | null;
  firstContentfulPaintMs: number | null;
  entries: TimingEntry[];
  /** Every slot this page read, at its first read (web-sdk's `slot-read:` marks). */
  slotReads: {
    slot: string;
    owner: string;
    contributors: string[];
    startMs: number;
  }[];
  /** When each React commit happened (web-core's commit bridge), page clock. */
  commits: number[];
  /** Resource Timing, long tasks and per-plugin imports, for the browser-track breakdown. */
  track: BrowserTrackInput;
}

interface Iteration {
  /** Epoch ms the stop returned (cold runs only). */
  stoppedAt: number | null;
  /** Epoch ms just before page.goto. */
  gotoAt: number;
  /** Why the iteration did not reach route content, or null when it did. Its partial data is kept either way. */
  failure: string | null;
  page: PageTimings;
  /** The server's boot profile, or why there is none (a timed-out load whose server never came up). */
  server: { ok: true; data: ProfilingData } | { ok: false; reason: string };
  /** Responses the server shed with 429 (load shedding — expected under host duress, so counted, not failed), by path. */
  shed: Record<string, number>;
  loadAvgEnd: number[];
  browser: BrowserTrack;
}

/** The gateway's state for this namespace, without waking its backend. */
async function gatewayState(): Promise<string> {
  const res = await agentFetch("/gateway/worktrees");
  if (!res.ok) throw new Error(`GET /gateway/worktrees: HTTP ${res.status}`);
  const list = (await res.json()) as { name: string; state: string }[];
  const entry = list.find((w) => w.name === namespace);
  if (!entry) throw new Error(`gateway has no worktree ${namespace}`);
  return entry.state;
}

async function readServerProfile(): Promise<Iteration["server"]> {
  // A timed-out load may leave the server down; asking it for its profile
  // would boot it, so read only a server that is already up.
  const state = await gatewayState();
  if (state !== "running")
    return { ok: false, reason: `server not up (gateway state ${state})` };
  const res = await agentFetch("/api/debug/profiling/boot");
  if (!res.ok)
    return {
      ok: false,
      reason: `GET /api/debug/profiling/boot: HTTP ${res.status}`,
    };
  return { ok: true, data: ProfilingDataSchema.parse(await res.json()) };
}

async function stopServer(): Promise<number> {
  const res = await agentFetch(
    `/gateway/worktrees/${encodeURIComponent(namespace)}/stop`,
    { method: "POST" },
  );
  const body = await res.text();
  // The machine's gateway is built from main's Go source: a 404 here is a
  // gateway that predates the route, not a missing worktree.
  if (res.status === 404)
    throw new Error(
      `POST /gateway/worktrees/${namespace}/stop → 404: the gateway predates the stop route — needs main's gateway with it (or run --no-stop for a warm check)`,
    );
  if (!res.ok)
    throw new Error(`stop ${namespace}: HTTP ${res.status} ${body.trim()}`);
  const status = JSON.parse(body) as { state?: unknown };
  r.eq(`stop ${namespace} → idle`, status.state, "idle");
  return Date.now();
}

// The later of the two end instants: route content commits at or after the
// first data commit.
const routeContentName = `${BOOT_TIMING_PREFIX}${ROUTE_CONTENT_COMMIT_ID}`;

// Row names, above the loop: a failed iteration prints its phases as it lands.
const ROUTE_CONTENT_ROW = "TOTAL page request → route content commit";
const FIRST_DATA_ROW = "TOTAL page request → first data commit";
const FIRST_REQUEST_ROW = "page request → first request reached the gateway";

const deferredCompleteName = `${BOOT_TIMING_PREFIX}${DEFERRED_LOAD_COMPLETE_ID}`;
const origin = new URL(url).origin;

/**
 * Before any page script: a Resource Timing buffer large enough for every
 * artifact (the default 250 drops most of them), a buffered long-task
 * observer from the very first task, and a subscriber on the React commit
 * bridge (index.html's inline script, which has run by `interactive`; React's
 * module scripts, and so every commit, come after it).
 */
async function instrument(context: BrowserContext): Promise<void> {
  if (reactProfile) await profileReactUntilRouteContent(context);
  await context.addInitScript(() => {
    performance.setResourceTimingBufferSize(100_000);
    const tasks: { startMs: number; durationMs: number }[] = [];
    window.__coldStartLongTasks = tasks;
    const commits: number[] = [];
    window.__coldStartCommits = commits;
    document.addEventListener("readystatechange", () => {
      if (document.readyState !== "interactive") return;
      const hook = (
        window as {
          __REACT_DEVTOOLS_GLOBAL_HOOK__?: {
            __commitSubscribers?: Set<() => void>;
          };
        }
      ).__REACT_DEVTOOLS_GLOBAL_HOOK__;
      const subs = hook?.__commitSubscribers;
      if (!subs)
        throw new Error("cold-start: no React commit bridge in index.html");
      subs.add(() => commits.push(performance.now()));
    });
    if (!PerformanceObserver.supportedEntryTypes.includes("longtask")) return;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries())
        tasks.push({ startMs: e.startTime, durationMs: e.duration });
    }).observe({ type: "longtask", buffered: true });
  });
}

/**
 * --code-cache: wipe everything the app keeps in the browser (cookies,
 * localStorage, IndexedDB, service workers, Cache Storage, …) but the HTTP
 * cache, so no data can come from a browser-side copy. sessionStorage is per
 * page, and every iteration opens a new one.
 */
async function clearBrowserStorage(
  context: BrowserContext,
  page: Page,
  tag: string,
): Promise<void> {
  const cdp = await context.newCDPSession(page);
  await cdp.send("Storage.clearDataForOrigin", {
    origin,
    storageTypes:
      "cookies,local_storage,indexeddb,service_workers,cache_storage,file_systems,websql,shader_cache",
  });
  await cdp.detach();
  const state = await context.storageState();
  r.ok(
    `${tag} browser storage cleared (HTTP cache kept)`,
    state.cookies.length === 0 &&
      state.origins.every((o) => o.localStorage.length === 0),
    JSON.stringify(state).slice(0, 300),
  );
}

/** Wait for a boot mark, push-based: true when recorded, false at the deadline. */
async function waitMark(
  page: Page,
  name: string,
  limitMs: number,
): Promise<boolean> {
  return page.evaluate(
    ([markName, ms]) =>
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), ms);
        new PerformanceObserver((list, obs) => {
          if (list.getEntriesByName(markName).length === 0) return;
          clearTimeout(timer);
          obs.disconnect();
          resolve(true);
        }).observe({ type: "mark", buffered: true });
      }),
    [name, limitMs] as const,
  );
}

/**
 * Load the page and wait for route content, then (best effort, within the
 * same budget) for the deferred tier to finish so tier C counts are whole.
 * A timeout is data, not an exception.
 */
/**
 * --react-profile: start debug/render-profiler the moment its Core.Root
 * installer assigns the window API (an accessor on that key — the installer's
 * effect runs at the first render, before first data), and stop it at the
 * route-content mark, so its report covers exactly the boot's commits.
 */
async function profileReactUntilRouteContent(
  context: BrowserContext,
): Promise<void> {
  await context.addInitScript(
    ([key, markName]) => {
      interface Api {
        start: (opts?: ProfilerStartOptions) => void;
        stop: () => void;
      }
      let api: Api | undefined;
      Object.defineProperty(window, key, {
        configurable: true,
        get: () => api,
        set: (value: Api) => {
          api = value;
          value.start({ maxDurationMs: 600_000 });
        },
      });
      new PerformanceObserver((list, observer) => {
        if (!list.getEntries().some((e) => e.name === markName)) return;
        observer.disconnect();
        if (!api)
          throw new Error(
            "cold-start --react-profile: route content before the render profiler was installed",
          );
        api.stop();
      }).observe({ type: "mark" });
    },
    [RENDER_PROFILER_GLOBAL, routeContentName] as const,
  );
}

async function readReactProfile(page: Page): Promise<ProfilerReport> {
  return page.evaluate((key) => {
    const api = (
      window as unknown as Record<
        string,
        { getReport: () => ProfilerReport } | undefined
      >
    )[key];
    if (!api)
      throw new Error("cold-start --react-profile: no render profiler API");
    return api.getReport();
  }, RENDER_PROFILER_GLOBAL);
}

async function loadPage(page: Page): Promise<{
  gotoAt: number;
  failure: string | null;
  timings: PageTimings;
  trace: string | null;
}> {
  const browser = page.context().browser();
  if (cpuProfile) {
    if (!browser) throw new Error("--cpu-profile: page has no browser");
    await browser.startTracing(page, { categories: CPU_TRACE_CATEGORIES });
  }
  const gotoAt = Date.now();
  const remaining = () => Math.max(0, timeoutMs - (Date.now() - gotoAt));
  let failure: string | null = null;
  // Cumulative main-thread metrics, read right after route content is seen.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  let mainThread: BrowserTrackInput["mainThread"] = null;
  try {
    await page.goto(url, { waitUntil: "commit", timeout: timeoutMs });
    if (!(await waitMark(page, routeContentName, remaining())))
      failure = `${routeContentName} not recorded within ${timeoutMs} ms`;
    else {
      const { metrics } = await cdp.send("Performance.getMetrics");
      const sampledAtMs = await page.evaluate(() => performance.now());
      const sec = (name: string): number =>
        (metrics.find((m) => m.name === name)?.value ?? NaN) * 1000;
      mainThread = {
        sampledAtMs,
        taskMs: sec("TaskDuration"),
        scriptMs: sec("ScriptDuration"),
        layoutMs: sec("LayoutDuration"),
        styleMs: sec("RecalcStyleDuration"),
      };
      await waitMark(page, deferredCompleteName, remaining());
    }
  } catch (err) {
    // Only the navigation's own timeout is a measurement; anything else is
    // a broken run.
    if (!(err instanceof Error && err.name === "TimeoutError")) throw err;
    failure = `navigation did not commit within ${timeoutMs} ms`;
  }
  await cdp.detach();
  const trace =
    cpuProfile && browser
      ? (await browser.stopTracing()).toString("utf8")
      : null;
  const evaluated = await page.evaluate(
    ([prefix, pluginPrefix, slotPrefix]): PageTimings => {
      const nav = performance.getEntriesByType("navigation")[0] as
        PerformanceNavigationTiming | undefined;
      const fcp = performance
        .getEntriesByType("paint")
        .find((e) => e.name === "first-contentful-paint");
      const userTiming = [
        ...performance.getEntriesByType("mark"),
        ...performance.getEntriesByType("measure"),
      ];
      const entries = userTiming
        .filter((e) => e.name.startsWith(prefix))
        .map((e) => ({
          id: e.name.slice(prefix.length),
          kind: e.entryType as "mark" | "measure",
          startMs: e.startTime,
          durationMs: e.duration,
          detail: (e as PerformanceMark | PerformanceMeasure)
            .detail as BootTimingDetail,
        }));
      const pluginLoads = userTiming
        .filter((e) => e.name.startsWith(pluginPrefix))
        .map((e) => {
          const detail = (e as PerformanceMeasure)
            .detail as BootPluginLoadDetail;
          return {
            pluginPath: e.name.slice(pluginPrefix.length),
            tier: detail.tier,
            ok: detail.ok,
            startMs: e.startTime,
            endMs: e.startTime + e.duration,
          };
        });
      const slotReads = performance
        .getEntriesByType("mark")
        .filter((e) => e.name.startsWith(slotPrefix))
        .map((e) => {
          const d = (e as PerformanceMark).detail as SlotReadDetail;
          return {
            slot: e.name.slice(slotPrefix.length),
            owner: d.owner,
            contributors: d.contributors,
            startMs: e.startTime,
          };
        });
      const resources = (
        performance.getEntriesByType("resource") as PerformanceResourceTiming[]
      ).map((e) => ({
        name: e.name,
        initiatorType: e.initiatorType,
        startMs: e.startTime,
        responseEndMs: e.responseEnd,
        transferSize: e.transferSize,
        decodedBodySize: e.decodedBodySize,
      }));
      // A navigation that has not finished reports 0 for its later stamps.
      const stamp = (v: number | undefined): number | null =>
        v === undefined || v === 0 ? null : v;
      const at = (id: string): number | null =>
        entries.find((e) => e.id === id)?.startMs ?? null;
      const span = (id: string) => {
        const e = entries.find((x) => x.id === id);
        return e
          ? { startMs: e.startMs, endMs: e.startMs + e.durationMs }
          : null;
      };
      return {
        timeOrigin: performance.timeOrigin,
        responseStartMs: stamp(nav?.responseStart),
        domContentLoadedMs: stamp(nav?.domContentLoadedEventEnd),
        firstContentfulPaintMs: fcp ? fcp.startTime : null,
        entries,
        slotReads,
        commits: window.__coldStartCommits ?? [],
        track: {
          documentTransfer: nav?.transferSize ?? 0,
          documentDecoded: nav?.decodedBodySize ?? 0,
          importMapBytes:
            document.querySelector('script[type="importmap"]')?.textContent
              ?.length ?? 0,
          domContentLoadedMs: stamp(nav?.domContentLoadedEventEnd),
          resources,
          longTasks: window.__coldStartLongTasks ?? [],
          pluginLoads,
          loadPlugins: span("load-plugins"),
          firstDataMs: at("first-data-commit"),
          routeContentMs: at("route-content-commit"),
          deferredCompleteMs: at("deferred-load-complete"),
          mainThread: null,
        },
      };
    },
    [
      BOOT_TIMING_PREFIX,
      BOOT_PLUGIN_TIMING_PREFIX,
      SLOT_READ_TIMING_PREFIX,
    ] as const,
  );
  const timings: PageTimings = {
    ...evaluated,
    track: { ...evaluated.track, mainThread },
  };
  return { gotoAt, failure, timings, trace };
}

/** --cpu-profile: the boot windows the trace is split over, on the page clock. */
function cpuWindows(track: BrowserTrackInput): CpuWindow[] {
  const lp = track.loadPlugins;
  if (!lp || track.firstDataMs === null || track.routeContentMs === null)
    return [];
  return [
    { name: "1 page request → load-plugins", startMs: 0, endMs: lp.startMs },
    { name: "2 load-plugins", startMs: lp.startMs, endMs: lp.endMs },
    {
      name: "3 load-plugins end → first data",
      startMs: lp.endMs,
      endMs: track.firstDataMs,
    },
    {
      name: "4 first data → route content",
      startMs: track.firstDataMs,
      endMs: track.routeContentMs,
    },
  ];
}

/**
 * R rows: the React commits between first data and route content — how many,
 * and the longest stretch with none (the main thread inside one render, or
 * busy with something other than React).
 */
function withCommits(track: BrowserTrack, timings: PageTimings): BrowserTrack {
  const { firstDataMs, routeContentMs } = timings.track;
  if (firstDataMs === null || routeContentMs === null) return track;
  if (timings.commits.length === 0)
    throw new Error(
      "cold-start: the page reached first data with no React commit recorded — is index.html's commit bridge gone?",
    );
  const inWindow = timings.commits.filter(
    (t) => t > firstDataMs && t <= routeContentMs,
  );
  const edges = [firstDataMs, ...inWindow];
  let longestGap = 0;
  for (let i = 1; i < edges.length; i++)
    longestGap = Math.max(longestGap, (edges[i] ?? 0) - (edges[i - 1] ?? 0));
  return {
    metrics: {
      ...track.metrics,
      "R commits before first data": timings.commits.filter(
        (t) => t <= firstDataMs,
      ).length,
      "R commits first data → route content": inWindow.length,
      "R longest ms without a commit in that window": longestGap,
    },
    lists: track.lists,
  };
}

/** S rows: how many distinct slots the page had read by each end instant. */
function withSlotReads(
  track: BrowserTrack,
  timings: PageTimings,
): BrowserTrack {
  const t = timings.track;
  const by = (endMs: number | null): number =>
    endMs === null
      ? NaN
      : timings.slotReads.filter((s) => s.startMs <= endMs).length;
  return {
    metrics: {
      ...track.metrics,
      "S slots read by first data": by(t.firstDataMs),
      "S slots read by route content": by(t.routeContentMs),
      "S slots read by deferred-load complete": by(t.deferredCompleteMs),
    },
    lists: track.lists,
  };
}

function withCpuProfile(
  track: BrowserTrack,
  timings: PageTimings,
  trace: string | null,
): BrowserTrack {
  const routeContentMs = timings.track.routeContentMs;
  if (trace === null || routeContentMs === null) return track;
  const cpu = summariseCpuTrace(
    trace,
    { markName: routeContentName, pageMs: routeContentMs },
    cpuWindows(timings.track),
  );
  return {
    metrics: { ...track.metrics, ...cpu.metrics },
    lists: { ...track.lists, ...cpu.lists },
  };
}

const iterationsRun = await withBrowser(async (h) => {
  const runs: Iteration[] = [];
  // --code-cache: one context for the whole run, its HTTP cache filled by one
  // load before the measured ones.
  //
  // Not a harness session: any Playwright route disables the HTTP cache, and
  // the harness routes every session (to strip its agent-provenance headers
  // from other origins — the app requests Google Fonts). So this context
  // carries no provenance headers and no route: nothing to leak, and the
  // cache works. Its requests are unmarked agent traffic (a page load's
  // telemetry writes); see CLAUDE.md.
  const shared = codeCache
    ? await (async () => {
        const context = await h.browser.newContext({
          viewport: { ...DEFAULT_VIEWPORT },
          colorScheme: detectOsColorScheme(),
        });
        return { context, page: await context.newPage() };
      })()
    : null;
  if (shared) {
    await instrument(shared.context);
    const warmUp = await loadPage(shared.page);
    if (warmUp.failure !== null)
      throw new Error(`code-cache warm-up load: ${warmUp.failure}`);
    await shared.page.close();
    console.log(`  code cache filled by one load`);
  }
  for (let i = 0; i < iterations; i++) {
    const stoppedAt = warm ? null : await stopServer();
    let page: Page;
    let close: () => Promise<void>;
    if (shared) {
      const p = await shared.context.newPage();
      await clearBrowserStorage(shared.context, p, `#${i + 1}`);
      page = p;
      close = () => p.close();
    } else {
      const session = await h.session();
      await instrument(session.context);
      page = session.page;
      close = () => session.context.close();
    }
    const shed: Record<string, number> = {};
    page.on("response", (res) => {
      if (res.status() !== 429) return;
      const path = new URL(res.url()).pathname;
      shed[path] = (shed[path] ?? 0) + 1;
    });
    const { gotoAt, failure, timings, trace } = await loadPage(page);
    if (reactProfile) {
      const profile = await readReactProfile(page);
      console.log(
        `  #${i + 1} React commits from the profiler's install to route content:\n` +
          formatProfilerReport(profile, { top: 30, commits: true })
            .split("\n")
            .map((l) => `    ${l}`)
            .join("\n"),
      );
    }
    if (trace !== null && out) {
      const tracePath = out.replace(/\.json$/, "") + `.trace-${i + 1}.json`;
      await Bun.write(tracePath, trace);
      console.log(`  #${i + 1} trace written to ${tracePath}`);
    }
    // Close BEFORE the next stop: an open page's socket would respawn the
    // server the moment it exits.
    await close();
    const run: Iteration = {
      stoppedAt,
      gotoAt,
      failure,
      page: timings,
      server: await readServerProfile(),
      shed,
      loadAvgEnd: loadavg(),
      browser: withCpuProfile(
        withCommits(
          withSlotReads(browserTrack(timings.track), timings),
          timings,
        ),
        timings,
        trace,
      ),
    };
    runs.push(run);
    printIteration(i, run);
  }
  return runs;
});

// --- Derivation -------------------------------------------------------------------

/** A phase on the timeline: its duration and where it ends, both in ms. `endAt` is null when it has no place on this load's timeline (a warm run's server boot). */
interface Phase {
  name: string;
  durationMs: number;
  endAt: number | null;
}

function entryStart(p: PageTimings, id: string): number | null {
  return p.entries.find((e) => e.id === id)?.startMs ?? null;
}

function phasesOf(run: Iteration): Phase[] {
  const phases: Phase[] = [];
  const zero = run.page.timeOrigin;
  const push = (name: string, durationMs: number, endAt: number | null) =>
    phases.push({ name, durationMs, endAt });
  const onTimeline = !warm;
  const at = (epochMs: number): number | null =>
    onTimeline ? epochMs - zero : null;

  // Totals. The headline is route content: the first screen a person sees
  // with data.
  const routeContent = entryStart(run.page, ROUTE_CONTENT_COMMIT_ID);
  if (routeContent !== null)
    push(ROUTE_CONTENT_ROW, routeContent, routeContent);
  const firstData = entryStart(run.page, FIRST_DATA_COMMIT_ID);
  if (firstData !== null) push(FIRST_DATA_ROW, firstData, firstData);

  // Gateway and server: only when the server's profile was read (a
  // timed-out load whose server never came up has the browser half alone).
  if (run.server.ok) {
    const s = run.server.data;
    const g = s.gateway;
    // How long the page took to send the request that woke the server — on
    // the cold timeline only (a warm server was woken by an earlier load).
    if (onTimeline && g?.spawnRequestedAt !== undefined)
      push(
        FIRST_REQUEST_ROW,
        g.spawnRequestedAt - zero,
        g.spawnRequestedAt - zero,
      );
    if (g?.spawnRequestedAt !== undefined && g.readyObservedAt !== undefined) {
      push(
        "gateway spawn requested → ready observed",
        g.readyObservedAt - g.spawnRequestedAt,
        at(g.readyObservedAt),
      );
      if (g.spawnedAt !== undefined) {
        push(
          "  gateway spawn requested → spawned",
          g.spawnedAt - g.spawnRequestedAt,
          at(g.spawnedAt),
        );
        push(
          "  gateway spawned → ready observed",
          g.readyObservedAt - g.spawnedAt,
          at(g.readyObservedAt),
        );
        // exec + the Bun runtime's own start, before any of our code runs.
        push(
          "  gateway spawned → server process start",
          s.processStartedAt - g.spawnedAt,
          at(s.processStartedAt),
        );
      }
    }

    // Span offsets are from the profiler's boot start, which sits
    // bootStartOffsetMs after process start.
    const base = s.processStartedAt + s.bootStartOffsetMs;
    const register = s.spans.filter((x) => x.phase === "register");
    if (register.length > 0) {
      const regStart = Math.min(...register.map((x) => x.startMs));
      const regEnd = Math.max(...register.map((x) => x.startMs + x.durationMs));
      push(
        "server process start → first register (code loading)",
        s.bootStartOffsetMs + regStart,
        at(base + regStart),
      );
      push("server register", regEnd - regStart, at(base + regEnd));
    }
    for (const phase of [
      "awaitPgReady",
      "runMigrations",
      "routePopulation",
      "socketBind",
    ]) {
      const span = s.spans.find(
        (x) => x.phase === phase && x.plugin === undefined,
      );
      if (span)
        push(
          `server ${phase}`,
          span.durationMs,
          at(base + span.startMs + span.durationMs),
        );
    }
    const blocking = s.spans.find(
      (x) => x.id === "onReadyBlocking" && x.plugin === undefined,
    );
    if (blocking) {
      const end = blocking.startMs + blocking.durationMs;
      push("server onReadyBlocking (all)", blocking.durationMs, at(base + end));
      for (const span of s.spans.filter(
        (x) => x.phase === "onReadyBlocking" && x.plugin !== undefined,
      )) {
        push(
          `  onReadyBlocking ${span.plugin}`,
          span.durationMs,
          at(base + span.startMs + span.durationMs),
        );
      }
      push(
        "server ready (process start → onReadyBlocking end)",
        s.bootStartOffsetMs + end,
        at(base + end),
      );
    }
  }

  // Browser.
  const p = run.page;
  if (p.responseStartMs !== null)
    push("document first byte (TTFB)", p.responseStartMs, p.responseStartMs);
  if (p.domContentLoadedMs !== null)
    push("DOMContentLoaded", p.domContentLoadedMs, p.domContentLoadedMs);
  if (p.firstContentfulPaintMs !== null)
    push(
      "first contentful paint",
      p.firstContentfulPaintMs,
      p.firstContentfulPaintMs,
    );
  for (const id of ["load-plugins", "boot-tasks", "boot-snapshot"]) {
    const e = p.entries.find((x) => x.id === id);
    if (e) push(`client ${id}`, e.durationMs, e.startMs + e.durationMs);
  }
  const setState = entryStart(p, "set-state");
  if (setState !== null)
    push("client set-state (first render scheduled)", setState, setState);
  return phases;
}

/** One line per iteration as it lands; a failed one lists everything it reached. */
function printIteration(i: number, run: Iteration): void {
  const tag = `  #${i + 1}`;
  const shedTotal = Object.values(run.shed).reduce((a, b) => a + b, 0);
  const shedNote = shedTotal > 0 ? `, ${shedTotal} shed (429)` : "";
  if (run.failure === null) {
    console.log(
      `${tag}: first data at ${ms(entryStart(run.page, FIRST_DATA_COMMIT_ID))} ms, route content at ${ms(entryStart(run.page, ROUTE_CONTENT_COMMIT_ID))} ms${shedNote}`,
    );
    return;
  }
  console.log(`${tag}: FAILED — ${run.failure}${shedNote}`);
  if (!run.server.ok) console.log(`      server: ${run.server.reason}`);
  console.log(`      reached (ms after the page request):`);
  for (const ph of phasesOf(run))
    console.log(
      `        ${ph.name.trim().padEnd(54)} ${ms(ph.durationMs).padStart(6)}  ends ${ms(ph.endAt)}`,
    );
  const marks = run.page.entries
    .filter((e) => !e.id.startsWith("res:"))
    .sort((a, b) => a.startMs - b.startMs)
    .map((e) => `${e.id} ${ms(e.startMs + e.durationMs)}`);
  console.log(`        boot marks: ${marks.join(", ") || "none"}`);
}

/** Per-entry snapshot rows: resource key, source, server work. */
function snapshotEntries(
  run: Iteration,
): { key: string; source: string; workMs: number }[] {
  return run.page.entries
    .filter((e) => e.id.startsWith("res:"))
    .map((e) => ({
      key: e.id.slice("res:".length),
      source: e.detail.detail ?? "?",
      workMs: e.detail.workMs ?? 0,
    }));
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1,
  );
  return sorted[Math.max(0, idx)] ?? NaN;
}
function stats(values: number[]): { min: number; median: number; p95: number } {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    min: sorted[0] ?? NaN,
    median: percentile(sorted, 50),
    p95: percentile(sorted, 95),
  };
}
// A declaration (hoisted): the iteration loop above logs with it.
function ms(n: number | null): string {
  return n === null || Number.isNaN(n) ? "—" : String(Math.round(n));
}

// --- Assertions -------------------------------------------------------------------

for (const [i, run] of iterationsRun.entries()) {
  const tag = `#${i + 1}`;
  r.ok(
    `${tag} reached route content`,
    run.failure === null,
    run.failure ?? undefined,
  );
  if (warm) continue;
  if (!run.server.ok) {
    r.fail(`${tag} server profile read`, run.server.reason);
    continue;
  }
  const s = run.server.data;
  r.ok(
    `${tag} gateway report present`,
    s.gateway?.spawnRequestedAt !== undefined &&
      s.gateway.readyObservedAt !== undefined,
    "the gateway did not POST /api/boot/gateway-report for this boot",
  );
  // The boot measured must be the one this load caused: the server process
  // started after the stop returned.
  r.ok(
    `${tag} server boot started after the stop`,
    run.stoppedAt !== null && s.processStartedAt >= run.stoppedAt,
    `process started ${ms(s.processStartedAt - (run.stoppedAt ?? 0))} ms after the stop — something else restarted it first`,
  );
}

// --- Report -----------------------------------------------------------------------

const perRun = iterationsRun.map(phasesOf);
const names: string[] = [];
for (const phases of perRun)
  for (const ph of phases) if (!names.includes(ph.name)) names.push(ph.name);

const loadEnd = iterationsRun.at(-1)?.loadAvgEnd ?? loadavg();

console.log("");
console.log(
  `=== cold-start ${url} — ${iterationsRun.length} iteration(s), busy=${busy}, ${warm ? "WARM (no stop)" : codeCache ? `cold server, ${DIAGNOSTIC} — not the headline` : "cold"} ===`,
);
console.log(
  `clock: one host wall clock — page timeOrigin, server timeOrigin and gateway stamps are epoch ms; offsets are relative to the page request (navigation start).`,
);
const W = 56;
console.log(
  `${"phase".padEnd(W)} ${"n".padStart(3)} ${"min".padStart(6)} ${"median".padStart(7)} ${"p95".padStart(6)}   ${"ends at (median)".padStart(16)}`,
);
console.log(
  `${"-".repeat(W)} ${"-".repeat(3)} ${"-".repeat(6)} ${"-".repeat(7)} ${"-".repeat(6)}   ${"-".repeat(16)}`,
);
const medians = new Map<string, number>();
for (const name of names) {
  const rows = perRun.flatMap((phases) =>
    phases.filter((p) => p.name === name),
  );
  const d = stats(rows.map((x) => x.durationMs));
  medians.set(name, d.median);
  const ends = rows.map((x) => x.endAt).filter((x): x is number => x !== null);
  const endMedian = ends.length > 0 ? stats(ends).median : null;
  console.log(
    `${name.slice(0, W).padEnd(W)} ${String(rows.length).padStart(3)} ${ms(d.min).padStart(6)} ${ms(d.median).padStart(7)} ${ms(d.p95).padStart(6)}   ${ms(endMedian).padStart(16)}`,
  );
}

// Snapshot entries: by source, then the heaviest keys by median server work.
const bySource = new Map<string, number[]>();
const byKey = new Map<string, { source: string; work: number[] }>();
for (const run of iterationsRun) {
  const counts = new Map<string, number>();
  for (const e of snapshotEntries(run)) {
    counts.set(e.source, (counts.get(e.source) ?? 0) + 1);
    const k = byKey.get(e.key) ?? { source: e.source, work: [] };
    k.work.push(e.workMs);
    k.source = e.source;
    byKey.set(e.key, k);
  }
  for (const [src, n] of counts)
    bySource.set(src, [...(bySource.get(src) ?? []), n]);
}
console.log("");
console.log(
  `boot snapshot entries by source (median count): ${[...bySource].map(([s, n]) => `${s} ${stats(n).median}`).join(", ") || "none"}`,
);
const heaviest = [...byKey]
  .map(([key, v]) => ({ key, source: v.source, median: stats(v.work).median }))
  .sort((a, b) => b.median - a.median)
  .slice(0, 8);
for (const e of heaviest)
  console.log(
    `  ${e.key.slice(0, 50).padEnd(50)} ${e.source.padEnd(9)} work ${ms(e.median)} ms`,
  );

// 429s are load shedding under host duress: expected under load, so counted
// rather than failed.
const shedByPath = new Map<string, number>();
for (const run of iterationsRun)
  for (const [path, n] of Object.entries(run.shed))
    shedByPath.set(path, (shedByPath.get(path) ?? 0) + n);
const shedTotal = [...shedByPath.values()].reduce((a, b) => a + b, 0);
console.log("");
console.log(
  `shed responses (429, not failures): ${shedTotal}${shedTotal > 0 ? ` — ${[...shedByPath].map(([path, n]) => `${path} ${n}`).join(", ")}` : ""}`,
);

// Browser track (see browser-track.ts): scalars as median (min–max) over the
// iterations, ranked lists by each name's median.
console.log("");
console.log(
  `browser track${codeCache ? ` (${DIAGNOSTIC})` : ""} — median (min–max) over ${iterationsRun.length} iteration(s):`,
);
const metricNames: string[] = [];
for (const run of iterationsRun)
  for (const name of Object.keys(run.browser.metrics))
    if (!metricNames.includes(name)) metricNames.push(name);
let section = "";
for (const name of metricNames) {
  if (name[0] !== section) {
    section = name[0] ?? "";
    console.log("");
  }
  const values = iterationsRun
    .map((run) => run.browser.metrics[name])
    .filter((v): v is number => v !== undefined && !Number.isNaN(v));
  if (values.length === 0) {
    console.log(`  ${name.padEnd(54)} —`);
    continue;
  }
  const st = stats(values);
  console.log(
    `  ${name.padEnd(54)} ${ms(st.median).padStart(7)}  (${ms(st.min)}–${ms(Math.max(...values))})`,
  );
}
const listNames: string[] = [];
for (const run of iterationsRun)
  for (const name of Object.keys(run.browser.lists))
    if (!listNames.includes(name)) listNames.push(name);
for (const name of listNames) {
  const byName = new Map<string, number[]>();
  for (const run of iterationsRun)
    for (const row of run.browser.lists[name] ?? [])
      byName.set(row.name, [...(byName.get(row.name) ?? []), row.value]);
  console.log("");
  console.log(`  ${name} — median, (seen in n runs):`);
  for (const [rowName, values] of [...byName]
    .map(([n, v]) => [n, v] as const)
    .sort((a, b) => stats(b[1]).median - stats(a[1]).median)
    .slice(0, 15))
    console.log(
      `    ${(rowName.length > 64 ? `…${rowName.slice(-63)}` : rowName).padEnd(64)} ${ms(stats(values).median).padStart(7)}  (${values.length})`,
    );
}

const fmtLoad = (l: number[]): string => l.map((x) => x.toFixed(2)).join(" ");
console.log("");
console.log(
  `load average (1/5/15 min, ${cpus().length} cpus): start ${fmtLoad(loadStart)} → end ${fmtLoad(loadEnd)}`,
);

const med = (name: string): string => ms(medians.get(name) ?? null);
const totalOf = (name: string) =>
  stats(
    perRun.flatMap((phases) =>
      phases.filter((p) => p.name === name).map((p) => p.durationMs),
    ),
  );
const total = totalOf(ROUTE_CONTENT_ROW);
const firstDataTotal = totalOf(FIRST_DATA_ROW);
console.log("");
console.log(
  `SUMMARY cold-start${warm ? " WARM" : codeCache ? ` ${DIAGNOSTIC}` : ""} ${new URL(url).pathname} n=${iterationsRun.length} busy=${busy}: ` +
    `reached ${iterationsRun.filter((x) => x.failure === null).length}/${iterationsRun.length} | ` +
    `route content median ${ms(total.median)} ms (p95 ${ms(total.p95)}) | ` +
    `first data ${ms(firstDataTotal.median)} (p95 ${ms(firstDataTotal.p95)}) | ` +
    `first request→gateway ${med(FIRST_REQUEST_ROW)} | ` +
    `gateway spawn→ready ${med("gateway spawn requested → ready observed")} | ` +
    `code load ${med("server process start → first register (code loading)")} | ` +
    `onReadyBlocking ${med("server onReadyBlocking (all)")} | ` +
    `snapshot ${med("client boot-snapshot")} | ` +
    `shed ${shedTotal} | ` +
    `load ${loadStart[0]?.toFixed(2)}→${loadEnd[0]?.toFixed(2)}`,
);

if (out) {
  await Bun.write(
    out,
    JSON.stringify(
      {
        url,
        namespace,
        warm,
        busy,
        capturedAt: new Date().toISOString(),
        loadAvg: { start: loadStart, end: loadEnd },
        iterations: iterationsRun.map((run, i) => ({
          ...run,
          phases: perRun[i],
          snapshotEntries: snapshotEntries(run),
        })),
      },
      null,
      2,
    ),
  );
  console.log(`wrote ${out}`);
}

await r.finish();
