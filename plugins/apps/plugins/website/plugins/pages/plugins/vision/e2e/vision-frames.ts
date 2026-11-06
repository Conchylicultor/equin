// Measures what the Vision zoom (`/website/vision`) costs a frame while it
// plays on its own: for each chapter, scrolled to its card and then left
// alone, the frame rate, the long animation frames (count, mean, worst; the
// style + layout share; script time by invoker) and the DOM writes per second
// the zoom makes — the before/after numbers for a change to its animation or
// to anything that watches the DOM (the render-loop detector). Beside those
// wall-clock numbers, the main thread's CPU time per second over the same
// window (a Chrome trace's thread time, `tdur`), split by trace event — script
// vs style recalc vs layout vs paint — so a throttled browser's waits are not
// read as the page's cost.
//
// Usage:
//   ./equin run plugins/apps/plugins/website/plugins/pages/plugins/vision/e2e/vision-frames.ts \
//     [--seconds 3] [--width 1400] [--height 900] [--headed]
//
// Manual only — nothing runs this automatically.

import type { CDPSession, Page } from "playwright";
import { z } from "zod";
import {
  boot,
  numArg,
  pathUrl,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const seconds = numArg("seconds", 3);
const width = numArg("width", 1400);
const height = numArg("height", 900);

interface FrameStats {
  fps: number;
  writesPerSec: number;
  longFrames: number;
  longMeanMs: number;
  longMaxMs: number;
  styleLayoutMeanMs: number;
  scriptByInvoker: [string, number][];
}

// A trace event, decoded at the boundary — only the fields read below.
const TraceEventSchema = z.looseObject({
  name: z.string(),
  ph: z.string(),
  ts: z.number(),
  dur: z.number().optional(),
  /** Thread CPU time of a complete event (µs). */
  tdur: z.number().optional(),
  pid: z.number(),
  tid: z.number(),
  args: z
    .looseObject({
      name: z.string().optional(),
      /** UpdateLayoutTree: how many elements the style recalc resolved. */
      elementCount: z.number().optional(),
    })
    .optional(),
});
type TraceEvent = z.infer<typeof TraceEventSchema>;

interface CpuStats {
  /** Main-thread CPU ms per second of the window. */
  cpuMsPerSec: number;
  /** Self CPU ms per second by trace event, the largest first. */
  selfMsPerSec: [string, number][];
  /**
   * Elements whose style was recalculated, per second: what the DOM writes
   * cost the style engine, independent of how loaded the host is.
   */
  restyledPerSec: number;
}

/** Trace the page's main thread while `work` runs; CPU per second, by event. */
async function traceCpu<T>(
  cdp: CDPSession,
  ms: number,
  work: () => Promise<T>,
): Promise<[T, CpuStats]> {
  const events: TraceEvent[] = [];
  const onData = (e: { value: object[] }) => {
    for (const raw of e.value) events.push(TraceEventSchema.parse(raw));
  };
  cdp.on("Tracing.dataCollected", onData);
  const done = new Promise<void>((resolve) =>
    cdp.once("Tracing.tracingComplete", () => resolve()),
  );
  await cdp.send("Tracing.start", {
    categories: "devtools.timeline,disabled-by-default-devtools.timeline",
    transferMode: "ReportEvents",
  });
  let result: T;
  try {
    result = await work();
  } finally {
    await cdp.send("Tracing.end");
    await done;
    cdp.off("Tracing.dataCollected", onData);
  }
  // the renderer main thread: the CrRendererMain that ran the most tasks
  const mains = new Set(
    events
      .filter(
        (e) => e.name === "thread_name" && e.args?.name === "CrRendererMain",
      )
      .map((e) => `${e.pid}:${e.tid}`),
  );
  const run = new Map<string, number>();
  for (const e of events)
    if (e.name === "RunTask" && mains.has(`${e.pid}:${e.tid}`))
      run.set(
        `${e.pid}:${e.tid}`,
        (run.get(`${e.pid}:${e.tid}`) ?? 0) + (e.tdur ?? 0),
      );
  const main = [...run].sort((a, b) => b[1] - a[1])[0];
  if (!main) throw new Error("no renderer main thread in the trace");
  const onMain = events
    .filter((e) => `${e.pid}:${e.tid}` === main[0] && e.ph === "X")
    .sort((a, b) => a.ts - b.ts || (b.dur ?? 0) - (a.dur ?? 0));
  // self CPU per event name: its CPU minus its direct children's
  const self = new Map<string, number>();
  const stack: { e: TraceEvent; child: number }[] = [];
  const close = (upTo: number) => {
    while (stack.length) {
      const top = stack[stack.length - 1]!;
      if (top.e.ts + (top.e.dur ?? 0) > upTo) break;
      stack.pop();
      self.set(
        top.e.name,
        (self.get(top.e.name) ?? 0) + (top.e.tdur ?? 0) - top.child,
      );
    }
  };
  for (const e of onMain) {
    close(e.ts);
    if (stack.length) stack[stack.length - 1]!.child += e.tdur ?? 0;
    stack.push({ e, child: 0 });
  }
  close(Infinity);
  const restyled = onMain
    .filter((e) => e.name === "UpdateLayoutTree")
    .reduce((n, e) => n + (e.args?.elementCount ?? 0), 0);
  const perSec = (us: number) => Math.round((us / 1000 / ms) * 1000 * 10) / 10;
  return [
    result,
    {
      cpuMsPerSec: perSec(main[1]),
      selfMsPerSec: [...self]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([k, v]) => [k, perSec(v)] as [string, number]),
      restyledPerSec: Math.round((restyled * 1000) / ms),
    },
  ];
}

/** Scroll the pane by wheel until chapter k's card sits at its middle. */
async function readChapter(page: Page, k: number): Promise<void> {
  for (let i = 0; i < 8; i++) {
    const dy = await page.evaluate((i) => {
      const card = document.querySelectorAll<HTMLElement>(".vs-card")[i];
      if (!card) throw new Error(`no chapter card ${i}`);
      let scroller: HTMLElement | null = card.parentElement;
      while (
        scroller &&
        !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)
      )
        scroller = scroller.parentElement;
      const sr = scroller?.getBoundingClientRect();
      const mid = (sr?.top ?? 0) + (scroller?.clientHeight ?? 0) / 2;
      const r = card.getBoundingClientRect();
      return r.top + r.height / 2 - mid;
    }, k);
    if (Math.abs(dy) < 4) break;
    await page.mouse.move(width / 2, height / 2);
    await page.mouse.wheel(0, dy);
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(900);
}

/** One window of the page left alone: frames, long frames and DOM writes. */
const measure = (page: Page, ms: number): Promise<FrameStats> =>
  page.evaluate(async (ms) => {
    let writes = 0;
    const mo = new MutationObserver((rs) => {
      writes += rs.length;
    });
    mo.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    const long: PerformanceEntry[] = [];
    const po = new PerformanceObserver((l) => long.push(...l.getEntries()));
    po.observe({ type: "long-animation-frame" });
    let frames = 0;
    const t0 = performance.now();
    await new Promise<void>((done) => {
      const tick = () => {
        frames++;
        if (performance.now() - t0 < ms) requestAnimationFrame(tick);
        else done();
      };
      requestAnimationFrame(tick);
    });
    mo.disconnect();
    po.disconnect();
    type Script = {
      invoker: string;
      sourceFunctionName: string;
      duration: number;
    };
    type Loaf = PerformanceEntry & {
      styleAndLayoutStart: number;
      scripts: Script[];
    };
    const loafs = long as Loaf[];
    const byInvoker = new Map<string, number>();
    for (const f of loafs)
      for (const s of f.scripts) {
        const key = `${s.invoker} ${s.sourceFunctionName}`.trim();
        byInvoker.set(key, (byInvoker.get(key) ?? 0) + s.duration);
      }
    const n = loafs.length || 1;
    return {
      fps: Math.round((frames * 1000) / ms),
      writesPerSec: Math.round((writes * 1000) / ms),
      longFrames: loafs.length,
      longMeanMs: Math.round(loafs.reduce((a, f) => a + f.duration, 0) / n),
      longMaxMs: Math.round(Math.max(0, ...loafs.map((f) => f.duration))),
      styleLayoutMeanMs: Math.round(
        loafs.reduce(
          (a, f) => a + (f.startTime + f.duration - f.styleAndLayoutStart),
          0,
        ) / n,
      ),
      scriptByInvoker: [...byInvoker]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([k, v]) => [k, Math.round(v)] as [string, number]),
    };
  }, ms);

await withBrowser(async (h) => {
  const { page } = await h.session({ viewport: { width, height } });
  const cdp = await page.context().newCDPSession(page);
  await boot(page, pathUrl("/website/vision"), {
    marker: "text=A vision for",
    settleMs: 1500,
  });
  for (let k = 0; k < 6; k++) {
    await readChapter(page, k);
    const [s, cpu] = await traceCpu(cdp, seconds * 1000, () =>
      measure(page, seconds * 1000),
    );
    console.log(`chapter ${k}: ${JSON.stringify(s)}`);
    // per frame: the host's load changes the frame rate, not what one frame costs
    const perFrame = (n: number) => (s.fps ? (n / s.fps).toFixed(1) : "-");
    console.log(
      `  per frame: ${perFrame(cpu.cpuMsPerSec)} ms CPU, ${perFrame(s.writesPerSec)} DOM writes, ${perFrame(cpu.restyledPerSec)} elements restyled`,
    );
    console.log(`  cpu: ${JSON.stringify(cpu)}`);
  }
  return true;
});
