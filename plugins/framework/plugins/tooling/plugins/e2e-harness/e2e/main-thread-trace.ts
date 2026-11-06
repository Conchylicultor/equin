// What a page's main thread does while it loads, native work included — the
// half a CPU profile only shows as "(program)": style recalcs, layouts,
// HTML/SVG parsing, module evaluation, GC. Records a Chrome trace
// (devtools.timeline) for --seconds from navigation, then prints every
// main-thread task's WALL time beside its thread CPU time (the trace's `tdur`),
// and the tasks that ran longest broken down by trace event and by the JS
// functions they called.
//
// Usage:
//   ./equin run plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/main-thread-trace.ts \
//     [--path /demo] [--seconds 30] [--tasks 8] [--top 12] [--out /tmp/main-thread-trace] [--foreground]
//
// Wall is not work. An agent's e2e run inherits darwinbg (efficiency cores,
// throttled), so on a loaded host the renderer waits seconds to be scheduled:
// /demo measured 124 tasks over 50 ms, 36.5 s wall but 1.6 s CPU (2026-11-06,
// load 40–90). A long-animation-frame or long-task count taken that way says
// how starved the browser was, not what the page costs. `--foreground` takes
// this process — and the Chromium it launches — out of darwinbg first, as the
// user's own browser runs; compare the CPU column either way.
//
// Writes `<out>.json` (load it in Chrome DevTools → Performance).

import { arg, flag, numArg } from "./args";
import { pageUrl } from "./target";
import { withBrowser } from "./browser";
import {
  leaveDarwinBackground,
  readDarwinBackground,
} from "@plugins/packages/plugins/spawn-priority/core";
import { writeFileSync } from "node:fs";
import { z } from "zod";

const seconds = numArg("seconds", 30);
const taskCount = numArg("tasks", 8);
const top = numArg("top", 12);
const url = pageUrl();
const out = arg("out", "/tmp/main-thread-trace");
if (flag("foreground")) leaveDarwinBackground();
console.log(`scheduling tier: ${readDarwinBackground().kind}`);

// A trace event as Chrome emits it — Playwright types the payload as string
// maps, so each event is decoded here, at the boundary. Only the fields read
// below are named; the rest pass through to the saved trace.
const TraceEventSchema = z.looseObject({
  name: z.string(),
  ph: z.string(),
  ts: z.number(),
  dur: z.number().optional(),
  /** Thread CPU time of a complete event (µs): how long it actually ran. */
  tdur: z.number().optional(),
  pid: z.number(),
  tid: z.number(),
  args: z
    .looseObject({
      name: z.string().optional(),
      data: z
        .looseObject({
          functionName: z.string().optional(),
          url: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
});
type TraceEvent = z.infer<typeof TraceEventSchema>;

const CATEGORIES = [
  "devtools.timeline",
  "disabled-by-default-devtools.timeline",
  "v8.execute",
  "blink.user_timing",
].join(",");

const events = await withBrowser(async (h) => {
  const { page } = await h.session();
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
  await page.goto(url, { waitUntil: "commit" });
  await page.waitForTimeout(seconds * 1000);
  console.log(
    `${await page.evaluate(() => document.querySelectorAll("*").length)} elements at the end`,
  );
  await cdp.send("Tracing.end");
  await done;
  return collected;
});

writeFileSync(`${out}.json`, JSON.stringify({ traceEvents: events }));

// The renderer's main thread: the thread named CrRendererMain of the process
// that ran the most RunTask time on it (the page, not an extension or worker).
const mainThreads = new Set(
  events
    .filter(
      (e) => e.name === "thread_name" && e.args?.name === "CrRendererMain",
    )
    .map((e) => `${e.pid}:${e.tid}`),
);
const runTime = new Map<string, number>();
for (const e of events)
  if (e.name === "RunTask" && mainThreads.has(`${e.pid}:${e.tid}`))
    runTime.set(
      `${e.pid}:${e.tid}`,
      (runTime.get(`${e.pid}:${e.tid}`) ?? 0) + (e.dur ?? 0),
    );
const main = [...runTime.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
if (main === undefined) throw new Error("no renderer main thread in trace");
const onMain = events
  .filter((e) => `${e.pid}:${e.tid}` === main && e.ph === "X")
  .sort((a, b) => a.ts - b.ts || (b.dur ?? 0) - (a.dur ?? 0));

const tasks = onMain.filter((e) => e.name === "RunTask");
const t0 =
  events.find((e) => e.name === "navigationStart")?.ts ?? tasks[0]?.ts ?? 0;
const long = tasks.filter((t) => (t.dur ?? 0) > 50_000);
const sumS = (xs: TraceEvent[], f: (e: TraceEvent) => number) =>
  (xs.reduce((n, e) => n + f(e), 0) / 1e6).toFixed(1);
console.log(
  `${long.length} main-thread tasks over 50 ms: ${sumS(long, (t) => t.dur ?? 0)} s wall, ${sumS(long, (t) => t.tdur ?? 0)} s CPU; every task: ${sumS(tasks, (t) => t.dur ?? 0)} s wall, ${sumS(tasks, (t) => t.tdur ?? 0)} s CPU`,
);
console.log("longest tasks by CPU time — at, wall, CPU:");
for (const t of [...tasks]
  .sort((a, b) => (b.tdur ?? 0) - (a.tdur ?? 0))
  .slice(0, taskCount))
  console.log(
    `  @${((t.ts - t0) / 1000).toFixed(0).padStart(6)} ms  ${((t.dur ?? 0) / 1000).toFixed(0).padStart(5)} ms  ${((t.tdur ?? 0) / 1000).toFixed(0).padStart(5)} ms`,
  );

const label = (e: TraceEvent): string => {
  const d = e.args?.data;
  if (e.name === "FunctionCall" && d)
    return `FunctionCall ${d.functionName || "(anonymous)"} ${(d.url ?? "").split("/").slice(-2).join("/")}`;
  if (e.name === "EvaluateScript" && d)
    return `EvaluateScript ${(d.url ?? "").split("/").slice(-2).join("/")}`;
  return e.name;
};

// Broken down: the tasks that RAN longest (CPU), not the ones that waited.
for (const task of [...tasks]
  .sort((a, b) => (b.tdur ?? 0) - (a.tdur ?? 0))
  .slice(0, taskCount)) {
  const end = task.ts + (task.dur ?? 0);
  const inside = onMain.filter(
    (e) => e !== task && e.ts >= task.ts && e.ts + (e.dur ?? 0) <= end,
  );
  // Self CPU time per event name: an event's CPU time minus its direct
  // children's (nesting is still decided on the wall clock).
  const self = new Map<string, number>();
  const stack: { e: TraceEvent; childDur: number }[] = [];
  const close = (upTo: number) => {
    while (stack.length > 0) {
      const top_ = stack[stack.length - 1]!;
      if (top_.e.ts + (top_.e.dur ?? 0) > upTo) break;
      stack.pop();
      const s = (top_.e.tdur ?? 0) - top_.childDur;
      self.set(top_.e.name, (self.get(top_.e.name) ?? 0) + s);
    }
  };
  for (const e of inside) {
    close(e.ts);
    if (stack.length > 0) stack[stack.length - 1]!.childDur += e.tdur ?? 0;
    stack.push({ e, childDur: 0 });
  }
  close(Infinity);
  const childOfTask = inside
    .filter(
      (e) =>
        !inside.some(
          (p) =>
            p !== e &&
            p.ts <= e.ts &&
            p.ts + (p.dur ?? 0) >= e.ts + (e.dur ?? 0) &&
            (p.dur ?? 0) > (e.dur ?? 0),
        ),
    )
    .reduce((n, e) => n + (e.dur ?? 0), 0);
  const calls = new Map<string, number>();
  for (const e of inside)
    if (
      e.name === "FunctionCall" ||
      e.name === "EvaluateScript" ||
      e.name === "TimerFire" ||
      e.name === "FireAnimationFrame"
    )
      calls.set(label(e), (calls.get(label(e)) ?? 0) + (e.tdur ?? 0));
  console.log("");
  console.log(
    `── task @${((task.ts - t0) / 1000).toFixed(0)} ms, ${((task.dur ?? 0) / 1000).toFixed(0)} ms wall, ${((task.tdur ?? 0) / 1000).toFixed(0)} ms CPU (untraced ${(((task.dur ?? 0) - childOfTask) / 1000).toFixed(0)} ms)`,
  );
  console.log("   self CPU by event:");
  for (const [name, us] of [...self.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, top))
    console.log(`   ${(us / 1000).toFixed(0).padStart(6)} ms  ${name}`);
  console.log("   calls (inclusive CPU):");
  for (const [name, us] of [...calls.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6))
    console.log(`   ${(us / 1000).toFixed(0).padStart(6)} ms  ${name}`);
}
