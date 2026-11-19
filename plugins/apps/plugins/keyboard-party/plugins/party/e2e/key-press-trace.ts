// What one Keyboard Party key press costs, split by where the work ran.
//
// Opens the party (default /demo/at/keyboard-party — the visitor's demo; pass
// --path /keyboard-party for the app itself), records a Chrome trace while
// pressing a fixed key sequence (a letter, "?", a digit, Space, an arrow …)
// one at a time, and prints per key:
//   - the Event Timing duration of its keydown (input → next paint), what the
//     slow-interaction report measures;
//   - the thread CPU (`tdur`) each thread spent in the 700 ms after the key —
//     renderer main, compositor, raster workers, GPU, audio — and the trace
//     events that took it (Paint, RasterTask, Layerize, UpdateLayerTree …).
//
// Usage:
//   ./equin run plugins/apps/plugins/keyboard-party/plugins/party/e2e/key-press-trace.ts \
//     [--url https://equin.ai/demo/at/keyboard-party] [--viewport 1440x900] \
//     [--keys "a,?,1,Space,ArrowUp,b"] [--gpu] [--out "$EQUIN_SCRATCH/kp-trace"]
//
// --open measures opening the party instead: the page (pass the demo's app
// grid, --url …/demo) is loaded, then its "Tap Tap Party" tile clicked — the
// click's Event Timing duration and the work in the 2 s after it.

import {
  arg,
  flag,
  pageUrl,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { writeFileSync } from "node:fs";
import { z } from "zod";

const url = pageUrl("/demo/at/keyboard-party");
const [vw, vh] = arg("viewport", "1440x900").split("x").map(Number);
const keys = arg("keys", "a,?,1,Space,ArrowUp,b,Shift,Enter,c,7").split(",");
const out = arg("out", "/dev/null");
/** CSS injected before measuring — to test what a rule costs. */
const css = arg("css", "");
const open = flag("open");
const WINDOW_US = open ? 2_000_000 : 700_000;

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
  "cc",
  "viz",
  "gpu",
  "blink.user_timing",
].join(",");

interface KeyTiming {
  key: string;
  duration: number;
  traceTs: number;
}

const { events, timings } = await withBrowser(
  async (h) => {
    const { page } = await h.session({
      viewport: { width: vw ?? 1440, height: vh ?? 900 },
    });
    await page.goto(url, { waitUntil: "load" });
    const stage = page.locator('[role="application"]');
    const tile = page.getByRole("button", { name: "Tap Tap Party" }).first();
    await (open ? tile : stage).waitFor({ timeout: 60_000 });
    if (css) await page.addStyleTag({ content: css });
    await page.waitForTimeout(3000);
    await page.evaluate(
      (measured) => {
        const w = window as unknown as { __kpEvents: number[] };
        w.__kpEvents = [];
        new PerformanceObserver((list) => {
          for (const e of list.getEntries())
            if (e.name === measured) w.__kpEvents.push(e.duration);
        }).observe({
          type: "event",
          durationThreshold: 16,
        } as PerformanceObserverInit);
      },
      open ? "click" : "keydown",
    );
    if (!open) await stage.focus();
    const cdp = await page.context().newCDPSession(page);
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
    await page.evaluate(() => performance.mark("kp-key idle"));
    await page.waitForTimeout(700);
    const marks: string[] = ["idle"];
    if (open) {
      await page.evaluate(() => performance.mark("kp-key open"));
      marks.push("open");
      await tile.click();
      await stage.waitFor({ timeout: 60_000 });
      await page.waitForTimeout(2500);
    }
    for (const key of open ? [] : keys) {
      await page.evaluate((k) => performance.mark(`kp-key ${k}`), key);
      marks.push(key);
      await page.keyboard.press(key === "?" ? "Shift+Slash" : key);
      await page.waitForTimeout(1500);
    }
    await cdp.send("Tracing.end");
    await done;
    const durations = [
      0,
      ...(await page.evaluate(
        () => (window as unknown as { __kpEvents: number[] }).__kpEvents,
      )),
    ];
    const markTs = collected
      .filter((e) => e.name.startsWith("kp-key "))
      .sort((a, b) => a.ts - b.ts)
      .map((e) => e.ts);
    return {
      events: collected,
      timings: marks.map((key, i): KeyTiming => ({
        key,
        duration: durations[i] ?? Number.NaN,
        traceTs: markTs[i] ?? Number.NaN,
      })),
    };
  },
  { gpu: flag("gpu") },
);

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
      top: [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6),
    });
  }
  return rows.sort((a, b) => b.total - a.total);
}

const ms = (us: number) => `${(us / 1000).toFixed(1)} ms`;
console.log(
  `page: ${url}  viewport ${vw}x${vh}  gpu ${flag("gpu")}${css ? `  css ${css}` : ""}`,
);
const totals = new Map<string, number>();
for (const t of timings) {
  console.log(
    `\n── ${t.key}: ${open ? "click" : "keydown"} ${t.duration.toFixed(0)} ms (Event Timing)`,
  );
  for (const row of split(t.traceTs, t.traceTs + WINDOW_US).slice(0, 6)) {
    if (t.key !== "idle")
      totals.set(row.thread, (totals.get(row.thread) ?? 0) + row.total);
    if (row.total < 1000) continue;
    console.log(
      `   ${row.thread.padEnd(28)} ${ms(row.total).padStart(9)}  ${row.top
        .filter(([, us]) => us >= 500)
        .map(([n, us]) => `${n} ${ms(us)}`)
        .join(", ")}`,
    );
  }
}

const pressed = timings.filter((t) => t.key !== "idle");
console.log(
  `\nmean over ${pressed.length} keys: ${open ? "click" : "keydown"} ${(pressed.reduce((n, t) => n + t.duration, 0) / pressed.length).toFixed(0)} ms; per key ${[
    ...totals.entries(),
  ]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([th, us]) => `${th} ${ms(us / pressed.length)}`)
    .join(", ")}`,
);
