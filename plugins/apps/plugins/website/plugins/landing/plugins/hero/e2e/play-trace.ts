// What pressing Play on the landing page's hero film costs, split by where the
// work ran.
//
// Opens the landing page (default /about — the website app; pass
// --url https://equin.ai/ for the public site) as a phone (touch, so the
// player draws its touch controls — the report's `TouchControls`), records a
// Chrome trace, taps Play, and prints:
//   - the Event Timing duration of the click (input → next paint) and its
//     presentation delay — what the slow-interaction report measures;
//   - the thread CPU (`tdur`) each thread spent in the window after the tap —
//     renderer main, compositor, raster, GPU, media — and the trace events
//     that took it;
//   - the frames: when the first frame after the tap was presented.
//
// Usage:
//   ./equin run plugins/apps/plugins/website/plugins/landing/plugins/hero/e2e/play-trace.ts \
//     [--url https://equin.ai/] [--viewport 390x844] [--cpu 4] [--window 2000] \
//     [--desktop] [--out "$EQUIN_SCRATCH/hero-play"]

import {
  arg,
  flag,
  pageUrl,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { writeFileSync } from "node:fs";
import { z } from "zod";

const url = pageUrl("/about");
const [vw, vh] = arg("viewport", "390x844").split("x").map(Number);
const out = arg("out", "/dev/null");
const cpu = Number(arg("cpu", "1"));
const WINDOW_US = Number(arg("window", "2000")) * 1000;
const touch = !flag("desktop");

const TraceEventSchema = z.looseObject({
  name: z.string(),
  ph: z.string(),
  ts: z.number(),
  dur: z.number().optional(),
  tdur: z.number().optional(),
  pid: z.number(),
  tid: z.number(),
  args: z.looseObject({ name: z.string().optional() }).optional(),
});
type TraceEvent = z.infer<typeof TraceEventSchema>;

const CATEGORIES = [
  "devtools.timeline",
  "disabled-by-default-devtools.timeline",
  "disabled-by-default-devtools.timeline.frame",
  "cc",
  "viz",
  "gpu",
  "media",
  "blink.user_timing",
].join(",");

interface ClickTiming {
  duration: number;
  processing: number;
  presentation: number;
}

const { events, timing, markTs } = await withBrowser(async (h) => {
  const { page } = await h.session({
    viewport: { width: vw ?? 390, height: vh ?? 844 },
    touch,
  });
  await page.goto(url, { waitUntil: "load" });
  const play = page.getByRole("button", { name: "Play", exact: true }).first();
  await play.waitFor({ state: "attached", timeout: 60_000 });
  await play.scrollIntoViewIfNeeded();
  await page.waitForTimeout(4000);
  await page.evaluate(() => {
    const w = window as unknown as { __hpEvents: unknown[] };
    w.__hpEvents = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as PerformanceEventTiming[])
        if (e.name === "click")
          w.__hpEvents.push({
            duration: e.duration,
            processing: e.processingEnd - e.processingStart,
            presentation: e.startTime + e.duration - e.processingEnd,
          });
    }).observe({
      type: "event",
      durationThreshold: 16,
    } as PerformanceObserverInit);
  });
  const cdp = await page.context().newCDPSession(page);
  if (cpu > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu });
  const collected: TraceEvent[] = [];
  cdp.on("Tracing.dataCollected", (e) => {
    for (const raw of e.value) collected.push(TraceEventSchema.parse(raw));
  });
  const done = new Promise<void>((resolve) =>
    cdp.once("Tracing.tracingComplete", () => resolve()),
  );
  await cdp.send("Tracing.start", {
    categories: CATEGORIES,
    transferMode: "ReportEvents",
  });
  await page.waitForTimeout(500);
  await page.evaluate(() => performance.mark("hp-play"));
  if (touch) await play.tap();
  else await play.click();
  await page.waitForTimeout(WINDOW_US / 1000 + 500);
  await cdp.send("Tracing.end");
  await done;
  const timings = await page.evaluate(
    () => (window as unknown as { __hpEvents: ClickTiming[] }).__hpEvents,
  );
  const mark = collected.find((e) => e.name === "hp-play");
  return {
    events: collected,
    timing: timings[0] ?? null,
    markTs: mark?.ts ?? Number.NaN,
  };
});

if (out !== "/dev/null")
  writeFileSync(`${out}.json`, JSON.stringify({ traceEvents: events }));

const threadName = new Map<string, string>();
for (const e of events)
  if (e.name === "thread_name" && e.args?.name)
    threadName.set(`${e.pid}:${e.tid}`, e.args.name);
const complete = events.filter((e) => e.ph === "X" && e.tdur !== undefined);

/** Self thread-CPU per (thread, event name) over [from, to). */
function split(from: number, to: number) {
  const byThread = new Map<string, TraceEvent[]>();
  for (const e of complete) {
    if (e.ts < from || e.ts >= to) continue;
    const k = `${e.pid}:${e.tid}`;
    const list = byThread.get(k) ?? [];
    list.push(e);
    byThread.set(k, list);
  }
  const rows: { thread: string; total: number; top: [string, number][] }[] = [];
  for (const [k, list] of byThread) {
    list.sort((a, b) => a.ts - b.ts || (b.dur ?? 0) - (a.dur ?? 0));
    const self = new Map<string, number>();
    const stack: { e: TraceEvent; child: number }[] = [];
    let total = 0;
    const close = (upTo: number) => {
      while (stack.length > 0) {
        const t = stack[stack.length - 1]!;
        if (t.e.ts + (t.e.dur ?? 0) > upTo) break;
        stack.pop();
        const s = (t.e.tdur ?? 0) - t.child;
        self.set(t.e.name, (self.get(t.e.name) ?? 0) + s);
      }
    };
    for (const e of list) {
      close(e.ts);
      if (stack.length > 0) stack[stack.length - 1]!.child += e.tdur ?? 0;
      else total += e.tdur ?? 0;
      stack.push({ e, child: 0 });
    }
    close(Infinity);
    rows.push({
      thread: threadName.get(k) ?? k,
      total,
      top: [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8),
    });
  }
  return rows.sort((a, b) => b.total - a.total);
}

const ms = (us: number) => `${(us / 1000).toFixed(1)} ms`;
console.log(`page: ${url}  viewport ${vw}x${vh}  touch ${touch}  cpu x${cpu}`);
console.log(
  timing
    ? `click: ${timing.duration.toFixed(0)} ms (processing ${timing.processing.toFixed(0)} ms, presentation delay ${timing.presentation.toFixed(0)} ms)`
    : "click: under 16 ms (no Event Timing entry)",
);

// The longest events on any thread in the window — what held the frame.
const longest = complete
  .filter((e) => e.ts >= markTs && e.ts < markTs + WINDOW_US)
  .sort((a, b) => (b.dur ?? 0) - (a.dur ?? 0))
  .slice(0, 15);
console.log("\nlongest events after the tap (wall / thread CPU):");
for (const e of longest)
  console.log(
    `  +${ms(e.ts - markTs).padStart(9)}  ${ms(e.dur ?? 0).padStart(9)} / ${ms(e.tdur ?? 0).padStart(9)}  ${e.name}  [${threadName.get(`${e.pid}:${e.tid}`) ?? e.tid}]`,
  );

console.log(`\nthread CPU in the ${WINDOW_US / 1000} ms after the tap:`);
for (const r of split(markTs, markTs + WINDOW_US)) {
  if (r.total < 1000) continue;
  console.log(`  ${r.thread.padEnd(28)} ${ms(r.total)}`);
  for (const [name, t] of r.top)
    if (t >= 500) console.log(`      ${ms(t).padStart(9)}  ${name}`);
}
