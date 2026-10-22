// Headless React render-profiler run for agents diagnosing a re-render loop.
//
// Opens a URL, starts a profiling session, waits N seconds while the suspect
// screen renders/idles, then prints the ranked top-N initiating components +
// hooks to stdout. The same ranked report is also dumped to the per-worktree
// `render-profiler.jsonl` log channel by the engine on stop.
//
// Usage:
//   ./singularity run plugins/debug/plugins/render-profiler/e2e/render-profile.ts [--url <url>] [--seconds 8] [--top 12]
//
// Example:
//   ./singularity run plugins/debug/plugins/render-profiler/e2e/render-profile.ts \
//     --url http://<worktree>.localhost:9000/agents/c/<id> \
//     --seconds 8

import {
  numArg,
  pageUrl,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import {
  formatProfilerReport,
  RENDER_PROFILER_GLOBAL,
  type ProfilerReport,
  type RenderProfilerWindow,
} from "@plugins/debug/plugins/render-profiler/core";

// An annotated alias: the imported const has a *widening* literal type, so
// passing it straight to `page.evaluate` would infer the arg as plain `string`
// and `w[g]` would no longer resolve to the profiler's API.
const PROFILER: typeof RENDER_PROFILER_GLOBAL = RENDER_PROFILER_GLOBAL;

const url = pageUrl();
const seconds = numArg("seconds", 8);
const top = numArg("top", 12);

const ok = await withBrowser(async (h) => {
  const { page } = await h.session();

  await page.goto(url);
  // Let the app boot and install the global API (Core.Root installer).
  await page.waitForTimeout(3000);

  const hasApi = await page.evaluate(
    (g: typeof RENDER_PROFILER_GLOBAL) =>
      typeof (window as RenderProfilerWindow)[g] !== "undefined",
    PROFILER,
  );
  if (!hasApi) {
    console.error(
      `window.${RENDER_PROFILER_GLOBAL} is undefined — the commit bridge or the\n` +
        "render-profiler plugin is not loaded. Run ./singularity build and retry.",
    );
    return false;
  }

  // Give the session a little headroom over our own wait before it auto-stops.
  const maxDurationMs = seconds * 1000 + 5000;
  await page.evaluate(
    ({ g, ms }: { g: typeof RENDER_PROFILER_GLOBAL; ms: number }) =>
      (window as RenderProfilerWindow)[g]?.start({ maxDurationMs: ms }),
    { g: PROFILER, ms: maxDurationMs },
  );
  console.log(`profiling for ${seconds}s at ${url}`);
  await page.waitForTimeout(seconds * 1000);

  const report: ProfilerReport = await page.evaluate(
    (g: typeof RENDER_PROFILER_GLOBAL) => {
      const api = (window as RenderProfilerWindow)[g];
      if (!api) throw new Error(`window.${g} disappeared mid-session`);
      api.stop();
      return api.getReport();
    },
    PROFILER,
  );

  // stop() dumps the ranked report to the `render-profiler` JSONL via clientLog,
  // which debounces ~250ms before POSTing. Give it time to flush before closing.
  await page.waitForTimeout(700);

  console.log("");
  console.log(formatProfilerReport(report, { top }));
  return true;
});

if (!ok) process.exit(1);
