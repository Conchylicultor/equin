// The WARM half of the load benchmark: what running the app's code costs once
// every byte of it is already in the browser's caches — the case a returning
// user of the local app is in on every load.
//
//   ./equin run plugins/debug/plugins/profiling/plugins/cold-start/e2e/warm-load.ts \
//     [--path /agents] [--iterations 5] [--coverage] [--out "$EQUIN_SCRATCH/warm.json"]
//
// One browser context (its HTTP and V8 code caches filled by one warm-up load,
// no Playwright route — any route disables the HTTP cache; see this plugin's
// CLAUDE.md on --code-cache), then per iteration a new page:
//
//   A. The real load: first paint, `boot:route-content-commit`, the
//      `boot:*` spans (the upfront plugin import among them), the renderer's
//      main-thread task / script time at route content and at
//      `boot:deferred-load-complete` — so "everything else" loaded after
//      first paint is the difference.
//   B. The upfront set alone (research/2026-11-12-global-load-model-redesign.md
//      §12.4, Q4, repeated): in a fresh same-origin `srcdoc` iframe holding only
//      the page's import map — an empty module map over warm caches —
//      `<link rel=modulepreload>` every module the page's HTML preloads (cache
//      read + compile), then `import()` them all (link + top-level evaluation).
//      The app's entry module is left out: it would boot a second app.
//      NOT comparable with §12.4's 1.8 s: since route chunks (2026-11-14) each
//      module's body sits in a lazy `__esmMin` init that only the app's own
//      boot calls, so importing the chunks links them without running module
//      bodies. A's in-page main-thread time is the comparable cost now.
//   C. How many source modules that set holds, read from each chunk's source
//      map (first-party vs npm).
//
// --coverage adds one more load under V8 precise coverage (call counts),
// taken at route content: a route chunk wraps each source module in its own
// `__esmMin` init function, so a module whose init ran is a module the route
// RAN before its content showed; the rest of the upfront set was loaded and
// never run. Coverage slows the page — its times are not reported.
//
// Wall times depend on the machine's load: the load average is printed per
// iteration, and medians with min–max are the numbers to quote.
//
// Written for the 2026-11-19 re-measure on the "Import time and lazy imports"
// track (task-1795102932-gsolx4).

import { loadavg } from "node:os";
import type { CDPSession, Page } from "playwright";
import {
  arg,
  DEFAULT_VIEWPORT,
  detectOsColorScheme,
  flag,
  isNpmSource as isNpm,
  numArg,
  pageUrl,
  ranModules,
  readScriptMaps as readMaps,
  startCoverage,
  takeCoverage,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import {
  BOOT_TIMING_PREFIX,
  DEFERRED_LOAD_COMPLETE_ID,
  ROUTE_CONTENT_COMMIT_ID,
} from "@plugins/primitives/plugins/perfs/plugins/boot-trace/core";

const iterations = numArg("iterations", 5);
const coverage = flag("coverage");
const out = arg("out");
const url = pageUrl("/agents");

const ROUTE_CONTENT = `${BOOT_TIMING_PREFIX}${ROUTE_CONTENT_COMMIT_ID}`;
const DEFERRED_DONE = `${BOOT_TIMING_PREFIX}${DEFERRED_LOAD_COMPLETE_ID}`;

interface MainThread {
  taskMs: number;
  scriptMs: number;
}

interface LoadRow {
  loadAvg: number;
  firstContentfulPaintMs: number | null;
  routeContentMs: number;
  deferredCompleteMs: number;
  spans: Record<string, { startMs: number; durationMs: number }>;
  atRouteContent: MainThread;
  atDeferredComplete: MainThread;
}

interface IsolatedRow {
  files: number;
  preloadMs: number;
  importMs: number;
}

/** Resolves once `name` is in the page's User Timing (a buffered observer, no polling). */
function waitForMark(page: Page, name: string): Promise<number> {
  return page.evaluate(
    (n) =>
      new Promise<number>((resolve) => {
        new PerformanceObserver((list, obs) => {
          const hit = list.getEntries().find((e) => e.name === n);
          if (hit === undefined) return;
          obs.disconnect();
          resolve(hit.startTime);
        }).observe({ type: "mark", buffered: true });
      }),
    name,
  );
}

async function mainThread(cdp: CDPSession): Promise<MainThread> {
  const { metrics } = (await cdp.send("Performance.getMetrics")) as {
    metrics: { name: string; value: number }[];
  };
  const m = (n: string) =>
    (metrics.find((x) => x.name === n)?.value ?? NaN) * 1000;
  return { taskMs: m("TaskDuration"), scriptMs: m("ScriptDuration") };
}

async function measureLoad(page: Page): Promise<LoadRow> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable", { timeDomain: "threadTicks" });
  const loadAvg = loadavg()[0] ?? NaN;
  await page.goto(url, { waitUntil: "commit" });
  const routeContentMs = await waitForMark(page, ROUTE_CONTENT);
  const atRouteContent = await mainThread(cdp);
  const deferredCompleteMs = await waitForMark(page, DEFERRED_DONE);
  const atDeferredComplete = await mainThread(cdp);
  const timing = await page.evaluate((prefix) => {
    const spans: Record<string, { startMs: number; durationMs: number }> = {};
    for (const e of performance.getEntriesByType("measure"))
      if (e.name.startsWith(prefix) && !(e.name in spans))
        spans[e.name] = { startMs: e.startTime, durationMs: e.duration };
    const fcp = performance
      .getEntriesByType("paint")
      .find((e) => e.name === "first-contentful-paint");
    return { spans, fcp: fcp === undefined ? null : fcp.startTime };
  }, BOOT_TIMING_PREFIX);
  await cdp.detach();
  return {
    loadAvg,
    firstContentfulPaintMs: timing.fcp,
    routeContentMs,
    deferredCompleteMs,
    spans: timing.spans,
    atRouteContent,
    atDeferredComplete,
  };
}

/** The page's HTML as served: its import map, its modulepreloads, its entry. */
async function upfrontSet(page: Page) {
  return page.evaluate(async (href) => {
    const html = await (await fetch(href)).text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    const entry = [...doc.querySelectorAll("script[type=module][src]")].map(
      (s) => new URL(s.getAttribute("src") ?? "", location.href).href,
    );
    const preloads = [...doc.querySelectorAll("link[rel=modulepreload]")]
      .map((l) => new URL(l.getAttribute("href") ?? "", location.href).href)
      .filter((h) => !entry.includes(h));
    const importMap =
      doc.querySelector("script[type=importmap]")?.textContent ?? "{}";
    return { importMap, preloads: [...new Set(preloads)], entry };
  }, url);
}

/** §12.4's measure: an empty module map over warm caches, the upfront set preloaded then imported. */
async function measureIsolated(
  page: Page,
  set: { importMap: string; preloads: string[] },
): Promise<IsolatedRow> {
  const frameName = `warm-eval-${Date.now()}`;
  await page.evaluate(
    ({ importMap, name }) =>
      new Promise<void>((resolve) => {
        const f = document.createElement("iframe");
        f.name = name;
        f.style.display = "none";
        f.srcdoc = `<!doctype html><script type="importmap">${importMap}</script>`;
        f.onload = () => resolve();
        document.body.append(f);
      }),
    { importMap: set.importMap, name: frameName },
  );
  const frame = page.frame({ name: frameName });
  if (frame === null) throw new Error("the srcdoc iframe did not attach");
  const row = await frame.evaluate(async (hrefs) => {
    const t0 = performance.now();
    await Promise.all(
      hrefs.map(
        (h) =>
          new Promise((resolve, reject) => {
            const l = document.createElement("link");
            l.rel = "modulepreload";
            l.href = h;
            l.onload = resolve;
            l.onerror = () => reject(new Error(`modulepreload failed: ${h}`));
            document.head.append(l);
          }),
      ),
    );
    const t1 = performance.now();
    await Promise.all(hrefs.map((h) => import(h)));
    const t2 = performance.now();
    return { preloadMs: t1 - t0, importMs: t2 - t1 };
  }, set.preloads);
  await page.evaluate((name) => {
    document.querySelector(`iframe[name="${name}"]`)?.remove();
  }, frameName);
  return { files: set.preloads.length, ...row };
}

// ── Run ─────────────────────────────────────────────────────────────────────

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? NaN : (s[Math.floor((s.length - 1) / 2)] ?? NaN);
};
const fmt = (xs: number[]) =>
  `${Math.round(median(xs))} ms (${Math.round(Math.min(...xs))}–${Math.round(Math.max(...xs))})`;

const result = await withBrowser(async (h) => {
  const context = await h.browser.newContext({
    viewport: { ...DEFAULT_VIEWPORT },
    colorScheme: detectOsColorScheme(),
  });
  const warmUp = await context.newPage();
  await measureLoad(warmUp);
  const set = await upfrontSet(warmUp);
  const maps = await readMaps(warmUp, set.preloads);
  await warmUp.close();

  const sourcesOf = (hrefs: Iterable<string>) => {
    const s = new Set<string>();
    for (const h of hrefs)
      for (const src of maps.get(h)?.sources ?? []) s.add(src);
    return s;
  };
  const upfrontSources = sourcesOf(set.preloads);
  const firstParty = [...upfrontSources].filter((s) => !isNpm(s)).length;
  console.log(
    `${url}: ${set.preloads.length} upfront files (entry excluded), ${maps.size} with a source map; ` +
      `${upfrontSources.size} source modules (${firstParty} first-party, ${upfrontSources.size - firstParty} npm)`,
  );

  const loads: LoadRow[] = [];
  const isolated: IsolatedRow[] = [];
  for (let i = 0; i < iterations; i++) {
    const page = await context.newPage();
    const row = await measureLoad(page);
    loads.push(row);
    const iso = await measureIsolated(page, set);
    isolated.push(iso);
    await page.close();
    console.log(
      `  #${i + 1} load avg ${row.loadAvg.toFixed(1)}: FCP ${Math.round(row.firstContentfulPaintMs ?? NaN)} ms, ` +
        `route content ${Math.round(row.routeContentMs)} ms, deferred done ${Math.round(row.deferredCompleteMs)} ms; ` +
        `main thread to route content ${Math.round(row.atRouteContent.taskMs)} ms (script ${Math.round(row.atRouteContent.scriptMs)}), ` +
        `route content → deferred done ${Math.round(row.atDeferredComplete.taskMs - row.atRouteContent.taskMs)} ms (script ${Math.round(row.atDeferredComplete.scriptMs - row.atRouteContent.scriptMs)}); ` +
        `isolated preload ${Math.round(iso.preloadMs)} ms, import ${Math.round(iso.importMs)} ms`,
    );
  }

  let ran: {
    called: number;
    calledFirstParty: number;
    upfront: number;
    upfrontFirstParty: number;
    ran: number;
    ranFirstParty: number;
  } | null = null;
  if (coverage) {
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await startCoverage(cdp);
    await page.goto(url, { waitUntil: "commit" });
    await waitForMark(page, ROUTE_CONTENT);
    // "Initialised": its `__esmMin` init ran; "called": another function of
    // it ran — the 2026-11-13 meaning of "ran" (§12.3).
    const { initialised: ranSources, called: calledSources } = ranModules(
      await takeCoverage(cdp),
      maps,
    );
    await page.close();
    const ranUpfront = [...ranSources].filter((s) => upfrontSources.has(s));
    const calledUpfront = [...calledSources].filter((s) =>
      upfrontSources.has(s),
    );
    ran = {
      called: calledUpfront.length,
      calledFirstParty: calledUpfront.filter((s) => !isNpm(s)).length,
      upfront: upfrontSources.size,
      upfrontFirstParty: firstParty,
      ran: ranUpfront.length,
      ranFirstParty: ranUpfront.filter((s) => !isNpm(s)).length,
    };
    console.log(
      `coverage at route content: ${ran.ran} of ${ran.upfront} upfront source modules had a function run ` +
        `(${ran.ranFirstParty} of ${ran.upfrontFirstParty} first-party) — initialised; ` +
        `${ran.called} had a function other than its init called (${ran.calledFirstParty} first-party)`,
    );
  }
  await context.close();
  return {
    loads,
    isolated,
    set: {
      files: set.preloads.length,
      modules: upfrontSources.size,
      firstParty,
    },
    ran,
  };
});

const { loads, isolated } = result;
const spanNames = [...new Set(loads.flatMap((l) => Object.keys(l.spans)))];
console.log(
  `\n=== warm load ${url} — median (min–max) over ${loads.length} ===`,
);
console.log(
  `load average ${loads.map((l) => l.loadAvg.toFixed(1)).join(", ")}`,
);
console.log(
  `first contentful paint     ${fmt(loads.map((l) => l.firstContentfulPaintMs ?? NaN))}`,
);
console.log(
  `route content              ${fmt(loads.map((l) => l.routeContentMs))}`,
);
console.log(
  `deferred load complete     ${fmt(loads.map((l) => l.deferredCompleteMs))}`,
);
console.log(
  `main thread → route content ${fmt(loads.map((l) => l.atRouteContent.taskMs))} (script ${fmt(loads.map((l) => l.atRouteContent.scriptMs))})`,
);
console.log(
  `main thread route content → deferred done ${fmt(loads.map((l) => l.atDeferredComplete.taskMs - l.atRouteContent.taskMs))} ` +
    `(script ${fmt(loads.map((l) => l.atDeferredComplete.scriptMs - l.atRouteContent.scriptMs))})`,
);
for (const n of spanNames) {
  const ds = loads.flatMap((l) =>
    l.spans[n] === undefined ? [] : [l.spans[n].durationMs],
  );
  console.log(`span ${n.padEnd(36)} ${fmt(ds)}`);
}
console.log(
  `isolated upfront set (${result.set.files} files, ${result.set.modules} modules): preload ${fmt(isolated.map((r) => r.preloadMs))}, import() ${fmt(isolated.map((r) => r.importMs))}`,
);
if (out !== undefined) await Bun.write(out, JSON.stringify(result, null, 2));
