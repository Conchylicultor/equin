// Standalone Playwright perf harness for Singularity — agent-readable frontend metrics.
//
// Installs PerformanceObservers before navigation (to catch LCP/CLS/longtask
// from the very first paint), then collects navigation timings, resource
// waterfall, and web vitals after the page settles.
//
// Usage:
//   ./singularity run plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/perf.ts \
//     [--url <url>] [--out <path>] [--wait-for-timeout <ms>] [--viewport-size "W,H"]
//
// --url takes a full page URL: its origin says which deploy, its path says which
// screen. Omit the path (or the flag) and you get this worktree's own deploy at
// the root, so the bare command profiles the app you just built. --base and
// --origin are aliases.
//
// Outputs:
//   - A concise summary table to stdout (so agents see it directly)
//   - `<out>-perf.json` — full structured data for deeper Read

import { arg, numArg } from "./args";
import { pageUrl } from "./target";
import { withBrowser } from "./browser";

interface LongTask {
  name: string;
  duration: number;
  startTime: number;
}
interface Vitals {
  lcp: number;
  cls: number;
  longTasks: LongTask[];
}
interface ResourceEntry {
  name: string;
  duration: number;
  transferSize: number;
  initiatorType: string;
}
/** Navigation Timing, as the plain object `PerformanceNavigationTiming.toJSON()` yields. */
type NavigationTiming = Record<string, number | string> | null;

// The observers below run in the page, so the accumulator they fill is a
// browser-side global: cast where it is read and written, not a `Window`
// augmentation — a global declaration would make every edit to this script
// re-check the whole repo.
type PerfWindow = Window & { __perf?: Vitals };

const url = pageUrl();
const out = arg("out", "/tmp/perf");
const waitMs = numArg("wait-for-timeout", 3000);
const viewportRaw = arg("viewport-size", "1280,800").split(",").map(Number);
const viewport = {
  width: viewportRaw[0] ?? 1280,
  height: viewportRaw[1] ?? 800,
};

const { perfData, consoleErrors } = await withBrowser(async (h) => {
  // capture() already collects console errors (and logs them as they happen).
  const { page, captured } = await h.session({ viewport });

  // Install PerformanceObservers BEFORE navigation so buffered entries are seen.
  await page.addInitScript(() => {
    const perf: Vitals = { lcp: 0, cls: 0, longTasks: [] };
    (window as PerfWindow).__perf = perf;

    // Each observer is independently optional: a browser that doesn't support
    // one entry type must not cost us the other two. Feature-DETECT via
    // supportedEntryTypes rather than try/catch around observe() — the
    // supported list is the API's own answer to "can I observe this?", so an
    // exception from observe() stays a real error we want to see.
    const supported: readonly string[] =
      PerformanceObserver.supportedEntryTypes;
    const observe = (
      type: string,
      cb: (list: PerformanceObserverEntryList) => void,
    ): void => {
      if (!supported.includes(type)) return;
      new PerformanceObserver(cb).observe({ type, buffered: true });
    };

    observe("largest-contentful-paint", (list) => {
      for (const entry of list.getEntries()) {
        const e = entry as PerformanceEntry & {
          renderTime?: number;
          loadTime?: number;
        };
        perf.lcp = e.renderTime || e.loadTime || 0;
      }
    });

    observe("layout-shift", (list) => {
      for (const entry of list.getEntries()) {
        const e = entry as PerformanceEntry & {
          hadRecentInput?: boolean;
          value?: number;
        };
        if (!e.hadRecentInput) perf.cls += e.value ?? 0;
      }
    });

    observe("longtask", (list) => {
      for (const entry of list.getEntries()) {
        perf.longTasks.push({
          name: entry.name,
          duration: entry.duration,
          startTime: entry.startTime,
        });
      }
    });
  });

  await page.goto(url, { waitUntil: "load" });
  await page.waitForTimeout(waitMs);

  const data = await page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0] as
      PerformanceNavigationTiming | undefined;
    const resources = performance.getEntriesByType("resource").map((entry) => {
      const e = entry as PerformanceResourceTiming;
      return {
        name: e.name,
        duration: Math.round(e.duration),
        transferSize: e.transferSize,
        initiatorType: e.initiatorType,
      };
    });
    return {
      navigation: (nav ? nav.toJSON() : null) as NavigationTiming,
      resources,
      vitals: (window as PerfWindow).__perf ?? {
        lcp: 0,
        cls: 0,
        longTasks: [],
      },
    };
  });

  return { perfData: data, consoleErrors: [...captured.consoleErrors] };
});

const { navigation, resources, vitals } = perfData as {
  navigation: NavigationTiming;
  resources: ResourceEntry[];
  vitals: Vitals;
};

// Slow API / WS resources (sorted by duration desc, top 20)
const slowApi = resources
  .filter((r) => r.name.includes("/api/") || r.name.includes("/ws"))
  .sort((a, b) => b.duration - a.duration)
  .slice(0, 20);

// Top 20 slowest resources overall
const slowestAll = [...resources]
  .sort((a, b) => b.duration - a.duration)
  .slice(0, 20);

const nav = navigation ?? {};
const navNum = (key: string): number => {
  const v = nav[key];
  return typeof v === "number" ? v : 0;
};
const dcl = Math.round(navNum("domContentLoadedEventEnd"));
const load = Math.round(navNum("loadEventEnd"));
const ttfb = Math.round(navNum("responseStart"));
const lcp = Math.round(vitals.lcp);
const cls = vitals.cls.toFixed(4);
const longTaskCount = vitals.longTasks.length;
const longTaskTotal = Math.round(
  vitals.longTasks.reduce((s, t) => s + t.duration, 0),
);

console.log("");
console.log("=== perf summary ===");
console.log(`url:              ${url}`);
console.log(`TTFB:             ${ttfb} ms`);
console.log(`DOMContentLoaded: ${dcl} ms`);
console.log(`load:             ${load} ms`);
console.log(`LCP:              ${lcp} ms`);
console.log(`CLS:              ${cls}`);
console.log(
  `long tasks:       ${longTaskCount} tasks, ${longTaskTotal} ms total`,
);

if (consoleErrors.length > 0) {
  console.log(`\nconsole errors (${consoleErrors.length}):`);
  for (const e of consoleErrors.slice(0, 10)) {
    console.log(`  [err] ${e.slice(0, 160)}`);
  }
}

const COL_W = 60;
const label = (name: string): string =>
  name.length > COL_W ? `…${name.slice(-(COL_W - 1))}` : name.padEnd(COL_W);

if (slowApi.length > 0) {
  console.log(
    `\nslow /api + /ws calls (top ${slowApi.length}, sorted by duration):`,
  );
  console.log(
    `  ${"name".padEnd(COL_W)} | ${"dur ms".padStart(6)} | ${"xfer B".padStart(8)}`,
  );
  console.log(`  ${"-".repeat(COL_W)} | ${"-".repeat(6)} | ${"-".repeat(8)}`);
  for (const r of slowApi) {
    console.log(
      `  ${label(r.name)} | ${String(r.duration).padStart(6)} | ${String(r.transferSize).padStart(8)}`,
    );
  }
} else {
  console.log("\nno /api or /ws resources captured");
}

if (slowestAll.length > 0) {
  console.log(`\ntop ${slowestAll.length} slowest resources (all types):`);
  console.log(`  ${"name".padEnd(COL_W)} | ${"dur ms".padStart(6)} | type`);
  console.log(`  ${"-".repeat(COL_W)} | ${"-".repeat(6)} | ----`);
  for (const r of slowestAll) {
    console.log(
      `  ${label(r.name)} | ${String(r.duration).padStart(6)} | ${r.initiatorType}`,
    );
  }
}

console.log("");

const outPath = `${out}-perf.json`;
const report = {
  url,
  capturedAt: new Date().toISOString(),
  waitForTimeoutMs: waitMs,
  viewport,
  navigation,
  vitals: {
    lcp,
    cls: vitals.cls,
    longTaskCount,
    longTaskTotalMs: longTaskTotal,
    longTasks: vitals.longTasks,
  },
  slowApi,
  slowestResources: slowestAll,
  allResources: resources,
  consoleErrors,
};

await Bun.write(outPath, JSON.stringify(report, null, 2));
console.log(`wrote ${outPath}`);
