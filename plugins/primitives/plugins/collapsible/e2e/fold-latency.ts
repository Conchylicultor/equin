// Fold-latency probe: how long a disclosure takes to RESPOND — from the click
// to the frame the fold starts moving — and where that time went. A fold that
// plays smoothly but starts late reads as lag; this puts a number on it.
//
// Usage:
//   ./singularity run plugins/primitives/plugins/collapsible/e2e/fold-latency.ts \
//     --path /agents/c/<conv> --trigger Expand [--count 5] [--settle 3000]
//
// --trigger is the accessible-name prefix of the disclosure triggers; the
// probe clicks the first --count of them that are closed (aria-expanded=false),
// one at a time — each a FIRST open, the content mounted from scratch. Per
// click it prints:
//   handler — the click's event processing (a sync render + commit of the
//             content lands here),
//   paint   — click → the next frame presented (Event Timing),
//   motion  — click → the fold's first animation (`Element.animate`) starting,
//   long    — the long tasks (≥ 50 ms) between the click and the motion.
// Headless Chrome under load paints few frames, so these are main-thread
// timings, not frame counts. Exit 1 when the median motion latency is over
// --budget ms (default 100).

import {
  arg,
  numArg,
  requireArg,
  requirePage,
  withBrowser,
  report,
  ELEMENT_TIMEOUT_MS,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const USAGE = "--path /agents/c/<conv> --trigger Expand";
const url = requirePage(USAGE);
const trigger = requireArg("trigger", USAGE);
const count = numArg("count", 5);
const settle = numArg("settle", 3000);
const budget = numArg("budget", 100);
const out = arg("out");

interface Sample {
  handler: number;
  paint: number;
  motion: number | null;
  long: number[];
}

const r = report(`fold latency: ${trigger}`);

await withBrowser(async (h) => {
  const { page } = await h.session({});
  // Before any app code: record each click, each animation's creation, every
  // long task and every event's timing.
  await page.addInitScript(() => {
    const w = window as unknown as {
      __fold: {
        clicks: number[];
        anims: number[];
        long: [number, number][];
        events: {
          start: number;
          procStart: number;
          procEnd: number;
          dur: number;
        }[];
      };
    };
    w.__fold = { clicks: [], anims: [], long: [], events: [] };
    document.addEventListener(
      "click",
      (e) => w.__fold.clicks.push(e.timeStamp),
      true,
    );
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (...args) {
      w.__fold.anims.push(performance.now());
      return animate.apply(this, args);
    };
    new PerformanceObserver((list) => {
      for (const e of list.getEntries())
        w.__fold.long.push([e.startTime, e.duration]);
    }).observe({ type: "longtask", buffered: true });
    // Event Timing's own option (lib.dom predates it): report every click
    // over one frame, not only those over the 104 ms default.
    const eventTiming: PerformanceObserverInit & { durationThreshold: number } =
      { type: "event", durationThreshold: 16, buffered: true };
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as PerformanceEventTiming[])
        if (e.name === "click")
          w.__fold.events.push({
            start: e.startTime,
            procStart: e.processingStart,
            procEnd: e.processingEnd,
            dur: e.duration,
          });
    }).observe(eventTiming);
  });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const closed = page.locator(
    `button[aria-expanded="false"][aria-label^="${trigger}"], ` +
      `[role="button"][aria-expanded="false"][aria-label^="${trigger}"]`,
  );
  await closed.first().waitFor({ timeout: ELEMENT_TIMEOUT_MS });
  await page.waitForTimeout(settle);

  const samples: Sample[] = [];
  for (let i = 0; i < count; i++) {
    const target = closed.first();
    if ((await target.count()) === 0) break;
    await target.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      const f = (window as unknown as { __fold: Record<string, unknown[]> })
        .__fold;
      f.clicks = [];
      f.anims = [];
      f.long = [];
      f.events = [];
    });
    await target.click();
    await page.waitForTimeout(1500);
    const f = await page.evaluate(
      () =>
        (
          window as unknown as {
            __fold: {
              clicks: number[];
              anims: number[];
              long: [number, number][];
              events: {
                start: number;
                procStart: number;
                procEnd: number;
                dur: number;
              }[];
            };
          }
        ).__fold,
    );
    const click = f.clicks[0];
    if (click === undefined) throw new Error("the click was not recorded");
    const anim = f.anims.find((t) => t >= click);
    const ev = f.events[0];
    samples.push({
      handler: ev ? Math.round(ev.procEnd - ev.procStart) : 0,
      paint: ev ? Math.round(ev.dur) : 0,
      motion: anim === undefined ? null : Math.round(anim - click),
      long: f.long
        .filter(([s]) => s >= click - 5 && (anim === undefined || s <= anim))
        .map(([, d]) => Math.round(d)),
    });
  }
  if (out) await page.screenshot({ path: `${out}.png` });

  for (const [i, s] of samples.entries())
    console.log(
      `#${i + 1}: handler ${s.handler}ms · paint ${s.paint}ms · motion ${
        s.motion ?? "none"
      }ms · long [${s.long.join(", ")}]`,
    );
  const motions = samples
    .map((s) => s.motion)
    .filter((m): m is number => m !== null)
    .sort((a, b) => a - b);
  const median = motions[Math.floor(motions.length / 2)];
  console.log(`median click → motion: ${median ?? "n/a"}ms`);
  r.ok("every click started a fold", motions.length === samples.length);
  r.ok(
    `median click → motion ≤ ${budget}ms`,
    median !== undefined && median <= budget,
  );
});
await r.finish();
