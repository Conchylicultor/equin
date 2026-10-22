// Headless deterministic live-state churn repro for agents diagnosing push-driven
// re-render storms / DOM thrash.
//
// Opens a URL, installs a MutationObserver before page JS, then drives a steady
// cadence of synthetic no-op live-state pushes (via window.__liveStateEmit) for a
// chosen resource key while the React render-profiler records commits. Prints the
// total DOM mutations + ranked top initiating components/hooks — a controlled,
// repeatable measurement that no longer depends on whether real pushes happen to
// be flowing.
//
// Usage:
//   ./singularity run plugins/debug/plugins/live-state-churn/plugins/emit/e2e/live-state-churn.ts --key <resourceKey> [--url <url>] [--rate 10] [--seconds 8]
//
// Example:
//   ./singularity run plugins/debug/plugins/live-state-churn/plugins/emit/e2e/live-state-churn.ts \
//     --url http://<worktree>.localhost:9000/agents \
//     --key tasks.list --rate 10 --seconds 8

import {
  numArg,
  pageUrl,
  requireArg,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import {
  formatProfilerReport,
  RENDER_PROFILER_GLOBAL,
  type ProfilerReport,
  type RenderProfilerWindow,
} from "@plugins/debug/plugins/render-profiler/core";
import {
  LIVE_STATE_EMIT_GLOBAL,
  type EmitStatus,
  type LiveStateEmitWindow,
} from "@plugins/debug/plugins/live-state-churn/plugins/emit/core";

/**
 * The window this driver reads: both Debug plugins' imperative APIs (each
 * published from its plugin's `core/`), and the DOM-mutation count the init
 * script below keeps. A cast where it is used, not a `Window` augmentation: a
 * global declaration would make every edit to this script re-check the whole
 * repo. Over `typeof window`, so the cast is a narrowing: `__domMutations` is
 * required.
 */
type ChurnWindow = typeof window &
  RenderProfilerWindow &
  LiveStateEmitWindow & {
    /** Added+removed node count since the init script ran (see addInitScript below). */
    __domMutations: number;
  };

// Annotated aliases: the imported consts have *widening* literal types, so
// passing one straight to `page.evaluate` would infer the arg as plain `string`
// and `w[g]` would no longer resolve to the APIs above.
const PROFILER: typeof RENDER_PROFILER_GLOBAL = RENDER_PROFILER_GLOBAL;
const EMIT: typeof LIVE_STATE_EMIT_GLOBAL = LIVE_STATE_EMIT_GLOBAL;

const url = pageUrl();
const key = requireArg(
  "key",
  "Usage: bun plugins/debug/plugins/live-state-churn/plugins/emit/e2e/live-state-churn.ts --key <resourceKey> [--url <url>] [--rate 10] [--seconds 8]",
);
const rate = numArg("rate", 10);
const seconds = numArg("seconds", 8);

const ok = await withBrowser(async (h) => {
  const { page } = await h.session();

  // Install a MutationObserver BEFORE page JS so we count every added/removed
  // node from the very first paint (the perf.ts addInitScript pattern).
  await page.addInitScript(() => {
    (window as ChurnWindow).__domMutations = 0;
    try {
      new MutationObserver((records) => {
        for (const r of records) {
          (window as ChurnWindow).__domMutations +=
            r.addedNodes.length + r.removedNodes.length;
        }
      }).observe(document.documentElement, { childList: true, subtree: true });
      // eslint-disable-next-line promise-safety/no-bare-catch -- pre-move behavior: MutationObserver is best-effort instrumentation; a document that refuses it must not abort the run.
    } catch (_) {}
  });

  await page.goto(url);
  // Let the app boot and install the global APIs (Core.Root installers).
  await page.waitForTimeout(3000);

  const hasApi = await page.evaluate(
    ({
      emitGlobal,
      profilerGlobal,
    }: {
      emitGlobal: typeof LIVE_STATE_EMIT_GLOBAL;
      profilerGlobal: typeof RENDER_PROFILER_GLOBAL;
    }) =>
      typeof (window as ChurnWindow)[emitGlobal] !== "undefined" &&
      typeof (window as ChurnWindow)[profilerGlobal] !== "undefined",
    { emitGlobal: EMIT, profilerGlobal: PROFILER },
  );
  if (!hasApi) {
    console.error(
      `window.${LIVE_STATE_EMIT_GLOBAL} and/or window.${RENDER_PROFILER_GLOBAL} are undefined —\n` +
        "the live-state-churn emit and render-profiler Debug plugins are not loaded.\n" +
        "Run ./singularity build and retry.",
    );
    return false;
  }

  // Start emission. start() does a fetch (returns a promise) — await it.
  // Give emission headroom over our own wait before its server-side auto-stop.
  const emitDurationMs = (seconds + 5) * 1000;
  const emitStatus: EmitStatus | undefined = await page.evaluate(
    ({
      g,
      key,
      rate,
      durationMs,
    }: {
      g: typeof LIVE_STATE_EMIT_GLOBAL;
      key: string;
      rate: number;
      durationMs: number;
    }) => (window as ChurnWindow)[g]?.start({ key, rate, durationMs }),
    { g: EMIT, key, rate, durationMs: emitDurationMs },
  );

  if (emitStatus && emitStatus.lastSubscriberCount === 0) {
    console.warn(
      `\n!! WARNING: nobody is subscribed to "${key}" on this route.\n` +
        `   lastSubscriberCount === 0 — the synthetic pushes are unobservable, so\n` +
        `   this run will measure nothing. Point --url at a view that renders the\n` +
        `   resource, or pick a key with active subscribers.\n`,
    );
  }

  // Start the render profiler with headroom over our own wait before it auto-stops.
  const maxDurationMs = (seconds + 2) * 1000;
  await page.evaluate(
    ({ g, ms }: { g: typeof RENDER_PROFILER_GLOBAL; ms: number }) =>
      (window as ChurnWindow)[g]?.start({ maxDurationMs: ms }),
    { g: PROFILER, ms: maxDurationMs },
  );

  console.log(
    `emitting "${key}" at ${rate}/s and profiling for ${seconds}s at ${url}`,
  );
  await page.waitForTimeout(seconds * 1000);

  const report: ProfilerReport = await page.evaluate(
    (g: typeof RENDER_PROFILER_GLOBAL) => {
      const api = (window as ChurnWindow)[g];
      if (!api) throw new Error(`window.${g} disappeared mid-session`);
      api.stop();
      return api.getReport();
    },
    PROFILER,
  );
  await page.evaluate(
    (g: typeof LIVE_STATE_EMIT_GLOBAL) => (window as ChurnWindow)[g]?.stop(),
    EMIT,
  );
  const mutations: number = await page.evaluate(
    () => (window as ChurnWindow).__domMutations,
  );

  // stop() dumps the ranked report to the `render-profiler` JSONL via clientLog,
  // which debounces ~250ms before POSTing. Give it time to flush before closing.
  await page.waitForTimeout(700);

  console.log("");
  console.log("=== live-state churn summary ===");
  console.log(`resource key:     ${key}`);
  console.log(`push rate:        ${rate}/s (scheduled)`);
  console.log(`observed:         ${seconds}s`);
  console.log(`DOM mutations:    ${mutations} total`);
  console.log(`                  ${(mutations / seconds).toFixed(1)}/s`);
  console.log(formatProfilerReport(report, { top: 12 }));
  console.log("");
  return true;
});

if (!ok) process.exit(1);
