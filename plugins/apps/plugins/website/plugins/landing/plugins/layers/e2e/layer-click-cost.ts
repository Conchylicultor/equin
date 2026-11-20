/**
 * What opening a layer's page from the homepage costs a visitor's phone: the
 * homepage (`/about`) on an emulated mid-range phone, its CPU throttled
 * (`--cpu`, default 4×), then a click on the layer card titled `--click`
 * (default "The technical foundations"), measured as the site's
 * slow-interaction reports measure it:
 *
 *  - the interaction: the longest Event Timing entry of the click (input
 *    delay, processing, presentation delay — click → next paint);
 *  - the long animation frames from the click until `--settle` ms after it,
 *    each script's forced style/layout, and their sum;
 *  - Chrome's own layout and style-recalc counts and durations over the same
 *    window (CDP `Performance.getMetrics`): how many times the page was laid
 *    out, not only for how long.
 *
 * Runs `--runs` times, each in a fresh context (the opened page's code not
 * cached in memory). `--gpu` renders with the machine's GPU.
 *
 * Manual only — nothing runs this automatically.
 *   ./equin run plugins/apps/plugins/website/plugins/landing/plugins/layers/e2e/layer-click-cost.ts \
 *     [--click "The technical foundations"] [--cpu 4] [--settle 3000] [--runs 3] [--gpu] [--desktop]
 */
import {
  arg,
  flag,
  numArg,
  pathUrl,
  report,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const CLICK = arg("click", "The technical foundations");
const CPU = numArg("cpu", 4);
const SETTLE_MS = numArg("settle", 3000);
const RUNS = numArg("runs", 3);
const GPU = flag("gpu");
const DESKTOP = flag("desktop");

/** Lighthouse's Moto G Power, as `home-load.ts` emulates it. */
const PHONE = {
  viewport: { width: 412, height: 823 },
  deviceScaleFactor: 1.75,
  isMobile: true,
  hasTouch: true,
  userAgent:
    "Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
};
const LAPTOP = { viewport: { width: 1440, height: 900 } };

interface Seen {
  events: {
    name: string;
    start: number;
    duration: number;
    processingStart: number;
    processingEnd: number;
  }[];
  frames: {
    start: number;
    duration: number;
    blocking: number;
    scripts: {
      invoker: string;
      fn: string;
      src: string;
      duration: number;
      forced: number;
    }[];
  }[];
}

declare global {
  interface Window {
    __layerClick?: Seen;
  }
}

/** Installed before the click: every event entry and long frame after it. */
function observe(): void {
  const seen: Seen = { events: [], frames: [] };
  window.__layerClick = seen;
  new PerformanceObserver((list) => {
    for (const e of list.getEntries() as PerformanceEventTiming[])
      seen.events.push({
        name: e.name,
        start: e.startTime,
        duration: e.duration,
        processingStart: e.processingStart,
        processingEnd: e.processingEnd,
      });
  }).observe({
    type: "event",
    durationThreshold: 16,
  } as PerformanceObserverInit);
  new PerformanceObserver((list) => {
    for (const f of list.getEntries() as unknown as {
      startTime: number;
      duration: number;
      blockingDuration: number;
      scripts: {
        invoker: string;
        sourceFunctionName: string;
        sourceURL: string;
        duration: number;
        forcedStyleAndLayoutDuration: number;
      }[];
    }[])
      seen.frames.push({
        start: f.startTime,
        duration: f.duration,
        blocking: f.blockingDuration,
        scripts: f.scripts.map((s) => ({
          invoker: s.invoker,
          fn: s.sourceFunctionName,
          src: s.sourceURL.split("/").slice(-2).join("/"),
          duration: s.duration,
          forced: s.forcedStyleAndLayoutDuration,
        })),
      });
  }).observe({ type: "long-animation-frame" });
}

const ms = (n: number) => `${Math.round(n)} ms`;

await withBrowser(
  async (h) => {
    const r = report(
      `layer-click-cost "${CLICK}" (${DESKTOP ? "laptop" : "phone"}, cpu ${CPU}×${GPU ? ", gpu" : ""})`,
    );
    const totals: { inp: number; forced: number; layouts: number }[] = [];
    for (let run = 1; run <= RUNS; run++) {
      const context = await h.browser.newContext(DESKTOP ? LAPTOP : PHONE);
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await page.goto(pathUrl("/about"), { waitUntil: "load" });
      const card = page.getByRole("button", { name: CLICK, exact: true });
      await card.waitFor({ state: "visible" });
      await card.scrollIntoViewIfNeeded();
      // let the homepage's own load work finish before the click is measured
      await page.waitForTimeout(1500);
      await cdp.send("Performance.enable");
      if (CPU > 1)
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU });
      await page.evaluate(observe);
      const metric = async () => {
        const { metrics } = await cdp.send("Performance.getMetrics");
        const m = new Map(metrics.map((x) => [x.name, x.value]));
        return {
          layouts: m.get("LayoutCount") ?? 0,
          layoutMs: (m.get("LayoutDuration") ?? 0) * 1000,
          styles: m.get("RecalcStyleCount") ?? 0,
          styleMs: (m.get("RecalcStyleDuration") ?? 0) * 1000,
        };
      };
      const before = await metric();
      await card.click();
      await page.waitForTimeout(SETTLE_MS);
      const after = await metric();
      const seen = await page.evaluate(() => window.__layerClick!);
      await context.close();

      const clicks = seen.events.filter((e) =>
        ["pointerdown", "pointerup", "click", "mousedown", "mouseup"].includes(
          e.name,
        ),
      );
      const inp = clicks.reduce((a, e) => Math.max(a, e.duration), 0);
      const top = clicks.find((e) => e.duration === inp);
      const forced = seen.frames
        .flatMap((f) => f.scripts)
        .reduce((a, s) => a + s.forced, 0);
      const layouts = after.layouts - before.layouts;
      totals.push({ inp, forced, layouts });
      console.log(`\n── run ${run}`);
      console.log(
        top === undefined
          ? "click: no event entry over 16 ms"
          : `click → next paint ${ms(inp)} (${top.name}; processing ${ms(top.processingEnd - top.processingStart)}, presentation ${ms(top.start + top.duration - top.processingEnd)})`,
      );
      console.log(
        `layouts ${layouts} (${ms(after.layoutMs - before.layoutMs)}), style recalcs ${after.styles - before.styles} (${ms(after.styleMs - before.styleMs)}), forced style/layout in long frames ${ms(forced)}`,
      );
      for (const f of seen.frames) {
        console.log(`  frame ${ms(f.duration)} (blocking ${ms(f.blocking)})`);
        for (const s of f.scripts)
          console.log(
            `    ${s.invoker} ${s.fn || "(anon)"} ${s.src}: ${ms(s.duration)}, forced ${ms(s.forced)}`,
          );
      }
    }
    const median = (xs: number[]) =>
      [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
    console.log(
      `\nmedian of ${RUNS}: click → next paint ${ms(median(totals.map((t) => t.inp)))}, forced style/layout ${ms(median(totals.map((t) => t.forced)))}, layouts ${median(totals.map((t) => t.layouts))}`,
    );
    r.ok("measured every run", totals.length === RUNS);
    await r.finish();
  },
  { gpu: GPU },
);
