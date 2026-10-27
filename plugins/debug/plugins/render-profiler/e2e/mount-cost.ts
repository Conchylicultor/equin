// Headless mount-cost measurement: what ONE in-app action mounts.
//
// Boots the app at a page, lets it settle, then profiles a single action —
// a client-side navigation (`--route`) or a click (`--click`) — so the numbers
// are the action's mount, not boot. Prints, per run and as a median over runs:
// commits, fibers mounted (every kind: components, providers, fragments, host
// elements), the largest tree size, long-task time during the action, and the
// fiber names the mount was made of.
//
// Usage:
//   ./equin run plugins/debug/plugins/render-profiler/e2e/mount-cost.ts \
//     --path /agents --route /agents/c/<id> [--runs 3] [--settle 4000] [--top 25]
//   ./equin run plugins/debug/plugins/render-profiler/e2e/mount-cost.ts \
//     --path /agents/tasks --pre-click '<selector>' --click '<selector>' [--runs 3]
//
// --click / --pre-click take a Playwright selector (first match). --pre-click
// runs before profiling starts, and only when it matches — e.g. fold a group
// if it is open (`[aria-expanded="true"]…`), then --click unfolds it.

import type { Page } from "playwright";
import {
  arg,
  numArg,
  pageUrl,
  usage,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import {
  RENDER_PROFILER_GLOBAL,
  type ProfilerReport,
  type RenderProfilerWindow,
} from "@plugins/debug/plugins/render-profiler/core";

// An annotated alias: the imported const has a *widening* literal type.
const PROFILER: typeof RENDER_PROFILER_GLOBAL = RENDER_PROFILER_GLOBAL;

const url = pageUrl();
const route = arg("route");
const click = arg("click");
const preClick = arg("pre-click");
const runs = numArg("runs", 3);
const settleMs = numArg("settle", 4000);
const top = numArg("top", 25);

if ((route === undefined) === (click === undefined)) {
  usage(
    "mount-cost.ts --path <boot page> (--route <in-app path> | --click <selector> [--pre-click <selector>]) [--runs 3] [--settle 4000] [--top 25]",
  );
}

interface RunResult {
  commits: number;
  mounted: number;
  maxTreeSize: number;
  longTaskMs: number;
  longestTaskMs: number;
  report: ProfilerReport;
}

type LongTaskWindow = Window & { __mountCostLongTasks?: number[] };

const results: RunResult[] = [];

/**
 * A DOM `click()` on the first match, not Playwright's pointer sequence: the
 * measured thing is what the click MOUNTS, and a pointer press on a drag-sortable
 * header also arms its drag sensor (an extra render the action does not own).
 */
async function clickIn(page: Page, selector: string): Promise<void> {
  await page
    .locator(selector)
    .first()
    .evaluate((el) => (el as HTMLElement).click());
}

const ok = await withBrowser(async (h) => {
  for (let i = 0; i < runs; i++) {
    const { page } = await h.session();
    await page.goto(url);

    // The profiler installs from a deferred plugin tier: wait for it.
    const hasApi = await page
      .waitForFunction(
        (g: typeof RENDER_PROFILER_GLOBAL) =>
          typeof (window as RenderProfilerWindow)[g] !== "undefined",
        PROFILER,
        { timeout: 60_000 },
      )
      .then(
        () => true,
        (err: unknown) => {
          if (err instanceof Error && err.name === "TimeoutError") return false;
          throw err;
        },
      );
    if (!hasApi) {
      console.error(
        `window.${RENDER_PROFILER_GLOBAL} is undefined after 60 s — run ./equin build and retry.`,
      );
      return false;
    }
    await page.waitForTimeout(settleMs);
    // A state-setting click, so it may already hold (a fold state persists
    // across runs): skipped when nothing matches.
    const preMatches =
      preClick === undefined ? 0 : await page.locator(preClick).count();
    if (preClick !== undefined)
      console.log(`pre-click: ${preMatches} match(es)`);
    if (preClick !== undefined && preMatches > 0) {
      await clickIn(page, preClick);
      await page.waitForTimeout(settleMs);
    }

    // Long tasks from here on: the action's main-thread blocking.
    await page.evaluate(() => {
      const w = window as LongTaskWindow;
      w.__mountCostLongTasks = [];
      new PerformanceObserver((list) => {
        for (const e of list.getEntries())
          w.__mountCostLongTasks!.push(e.duration);
      }).observe({ type: "longtask" });
    });
    await page.evaluate(
      ({ g, ms }: { g: typeof RENDER_PROFILER_GLOBAL; ms: number }) =>
        (window as RenderProfilerWindow)[g]?.start({ maxDurationMs: ms }),
      { g: PROFILER, ms: settleMs + 30_000 },
    );

    if (route !== undefined) {
      // In-app navigation: the pane router restores from the URL on popstate.
      await page.evaluate((path: string) => {
        window.history.pushState(null, "", path);
        window.dispatchEvent(new PopStateEvent("popstate"));
      }, route);
    } else {
      await clickIn(page, click!);
    }
    await page.waitForTimeout(settleMs);

    const report: ProfilerReport = await page.evaluate(
      (g: typeof RENDER_PROFILER_GLOBAL) => {
        const api = (window as RenderProfilerWindow)[g];
        if (!api) throw new Error(`window.${g} disappeared mid-session`);
        api.stop();
        return api.getReport();
      },
      PROFILER,
    );
    const longTasks = await page.evaluate(
      () => (window as LongTaskWindow).__mountCostLongTasks ?? [],
    );
    const result: RunResult = {
      commits: report.totalCommits,
      mounted: report.commits.reduce((n, c) => n + c.mounted, 0),
      maxTreeSize: Math.max(0, ...report.commits.map((c) => c.treeSize)),
      longTaskMs: longTasks.reduce((n, d) => n + d, 0),
      longestTaskMs: Math.max(0, ...longTasks),
      report,
    };
    results.push(result);
    console.log(
      `run ${i + 1}: ${result.commits} commits · ${result.mounted} fibers mounted · tree ${result.maxTreeSize} · long tasks ${result.longTaskMs.toFixed(0)} ms (longest ${result.longestTaskMs.toFixed(0)} ms)`,
    );
    await page.close();
  }
  return true;
});

if (!ok) process.exit(1);

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};
console.log("");
console.log(
  `median over ${results.length}: ${median(results.map((r) => r.commits))} commits · ${median(results.map((r) => r.mounted))} fibers mounted · tree ${median(results.map((r) => r.maxTreeSize))} · long tasks ${median(results.map((r) => r.longTaskMs)).toFixed(0)} ms (longest ${median(results.map((r) => r.longestTaskMs)).toFixed(0)} ms)`,
);

// The median run's composition and commits.
const mid = [...results].sort((a, b) => a.mounted - b.mounted)[
  Math.floor(results.length / 2)
]!;
console.log("");
console.log("commits of the median run — ms, rendered, mounted, tree size:");
for (const c of mid.report.commits)
  console.log(
    `${c.atMs.toFixed(0).padStart(7)}  ${c.rendered.toString().padStart(6)}  ${c.mounted.toString().padStart(6)}  ${c.treeSize.toString().padStart(7)}  ${c.initiators
      .slice(0, 3)
      .map((x) => `${x.name} ${x.rendered}`)
      .join(", ")}`,
  );
console.log("");
console.log("fibers mounted by name (median run):");
for (const m of mid.report.mounts.slice(0, top))
  console.log(`${m.count.toString().padStart(7)}  ${m.name}`);
console.log("");
console.log("remounts (median run):");
for (const r of mid.report.remounts.slice(0, 12))
  console.log(
    `${r.count.toString().padStart(5)}  ${r.ancestorPath.slice(-3).join(" > ")} > ${r.fromType} > ${r.toType}  [${r.cause}]`,
  );
