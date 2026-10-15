// How smooth wheel-zooming the /places map is on THIS checkout's deploy: zooms
// in and out with the wheel over the map's middle, recording every frame's
// interval (rAF), the browser's own work counters (script, style, layout) and a
// CPU profile, then prints the frame-time distribution and the heaviest
// functions.
//
// Usage:
//   ./singularity run plugins/apps/plugins/places/plugins/places-map/e2e/zoom-perf.ts \
//     [--out /tmp/places-zoom] [--top 15] [--steps 8] [--hide-pins] [--no-profile] [--trace] [--css "<rules>"]
//
// `--hide-pins` hides every pin overlay (display: none) before zooming — the
// baseline of Google's map alone, so the pins' share of the cost reads as the
// difference. Writes `<out>.cpuprofile` (Chrome DevTools → Performance).

import {
  arg,
  numArg,
  pathUrl,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { writeFileSync } from "node:fs";

const out = arg("out", "/tmp/places-zoom");
const top = numArg("top", 15);
const steps = numArg("steps", 8);
const hidePins = process.argv.includes("--hide-pins");
// The CPU profiler slows every frame; off, the frame times are the real ones.
const profiling = !process.argv.includes("--no-profile");
// A Chrome trace of the zoom, summarised by event (paint, layout, composite …).
const tracing = process.argv.includes("--trace");

interface ProfileNode {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number };
}
interface Profile {
  nodes: ProfileNode[];
  samples?: number[];
  timeDeltas?: number[];
}

function selfTimes(profile: Profile): { name: string; ms: number }[] {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const ms = new Map<string, number>();
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  for (let i = 0; i < samples.length; i++) {
    const node = byId.get(samples[i]!);
    if (node === undefined) continue;
    const { functionName, url, lineNumber } = node.callFrame;
    const file = url.split("/").pop() ?? url;
    const key = `${functionName || "(anonymous)"} ${file}:${lineNumber + 1}`;
    ms.set(key, (ms.get(key) ?? 0) + (deltas[i] ?? 0) / 1000);
  }
  return [...ms.entries()]
    .map(([name, v]) => ({ name, ms: v }))
    .sort((a, b) => b.ms - a.ms);
}

interface TraceEvent {
  name: string;
  ph: string;
  dur?: number;
  tid: number;
  pid: number;
}

/** Complete-event time by name on the busiest thread (the renderer main). */
function printTrace(buf: Buffer): void {
  writeFileSync(`${out}.trace.json`, buf);
  const { traceEvents } = JSON.parse(buf.toString()) as {
    traceEvents: TraceEvent[];
  };
  const perThread = new Map<string, Map<string, number>>();
  for (const e of traceEvents) {
    if (e.ph !== "X" || e.dur === undefined) continue;
    const key = `${e.pid}:${e.tid}`;
    const names = perThread.get(key) ?? new Map<string, number>();
    names.set(e.name, (names.get(e.name) ?? 0) + e.dur / 1000);
    perThread.set(key, names);
  }
  const threads = [...perThread.entries()]
    .map(([k, names]) => ({ k, total: names.get("RunTask") ?? 0, names }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 2);
  for (const t of threads) {
    console.log(`[trace] thread ${t.k} RunTask ${t.total.toFixed(0)} ms:`);
    for (const [name, ms] of [...t.names.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, top)) {
      console.log(`    ${ms.toFixed(0).padStart(6)} ms  ${name}`);
    }
  }
}

const METRICS = [
  "TaskDuration",
  "ScriptDuration",
  "RecalcStyleDuration",
  "LayoutDuration",
  "RecalcStyleCount",
  "LayoutCount",
  "Nodes",
] as const;

await withBrowser(async (h) => {
  const { page } = await h.session({
    viewport: { width: 1440, height: 900 },
    colorScheme: "light",
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
  const metrics = async (): Promise<Record<string, number>> => {
    const { metrics: all } = (await cdp.send("Performance.getMetrics")) as {
      metrics: { name: string; value: number }[];
    };
    return Object.fromEntries(all.map((m) => [m.name, m.value]));
  };

  const overlays = page.locator(".gm-style [role=button][aria-label]");
  await page.goto(pathUrl("/places"), { waitUntil: "commit" });
  await overlays.first().waitFor({ timeout: 120_000 });
  await page.waitForTimeout(5000);
  console.log(`[setup] pin overlays on map ${await overlays.count()}`);
  const visible = await overlays.evaluateAll(
    (els) =>
      els.filter((el) => {
        const r = el.getBoundingClientRect();
        return (
          r.right > 0 &&
          r.bottom > 0 &&
          r.left < innerWidth &&
          r.top < innerHeight
        );
      }).length,
  );
  console.log(`[setup] of which in the viewport ${visible}`);
  const css = arg("css", "");
  if (css !== "") {
    await page.addStyleTag({ content: css });
    console.log(`[setup] extra css: ${css}`);
  }
  if (hidePins) {
    await page.addStyleTag({
      content: ".gm-style [role=button][aria-label] { display: none }",
    });
    console.log("[setup] pins hidden (baseline)");
  }

  const map = await page.getByTestId("map").boundingBox();
  if (map === null) throw new Error("no map on the page");
  await page.mouse.move(map.x + map.width / 2, map.y + map.height / 2);

  // Every frame's interval while zooming.
  await page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __stop: boolean };
    w.__frames = [];
    w.__stop = false;
    let last = performance.now();
    const tick = (t: number) => {
      w.__frames.push(t - last);
      last = t;
      if (!w.__stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const before = await metrics();
  if (profiling) await cdp.send("Profiler.start");
  const browser = page.context().browser();
  if (tracing) {
    if (browser === null) throw new Error("no browser to trace");
    await browser.startTracing(page, {
      categories: [
        "devtools.timeline",
        "disabled-by-default-devtools.timeline",
      ],
    });
  }
  const t0 = Date.now();
  // In, then back out: a trackpad-like stream of small wheel deltas.
  for (const dir of [-1, 1]) {
    for (let i = 0; i < steps; i++) {
      for (let j = 0; j < 10; j++) {
        await page.mouse.wheel(0, dir * 25);
        await page.waitForTimeout(16);
      }
      await page.waitForTimeout(150);
    }
  }
  await page.waitForTimeout(1000);
  const elapsed = Date.now() - t0;
  const profile = profiling
    ? ((await cdp.send("Profiler.stop")) as { profile: Profile }).profile
    : null;
  const after = await metrics();
  if (tracing && browser !== null) printTrace(await browser.stopTracing());
  const frames = await page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __stop: boolean };
    w.__stop = true;
    return w.__frames.slice(1);
  });
  if (profile !== null) {
    writeFileSync(`${out}.cpuprofile`, JSON.stringify(profile));
  }

  const sorted = [...frames].sort((a, b) => a - b);
  const pct = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
  const janky = frames.filter((f) => f > 34).length;
  console.log(
    `[zoom] ${elapsed} ms, ${frames.length} frames (${((frames.length / elapsed) * 1000).toFixed(1)} fps)`,
  );
  console.log(
    `[zoom] frame ms p50 ${pct(0.5).toFixed(1)} p90 ${pct(0.9).toFixed(1)} p99 ${pct(0.99).toFixed(1)} max ${(sorted.at(-1) ?? 0).toFixed(1)}; >34 ms: ${janky}`,
  );
  for (const m of METRICS) {
    const d = (after[m] ?? 0) - (before[m] ?? 0);
    const v = m.endsWith("Duration") ? `${(d * 1000).toFixed(0)} ms` : `${d}`;
    console.log(`[zoom] ${m.padEnd(20)} ${v}`);
  }
  if (profile === null) return;
  const busy = selfTimes(profile).filter((e) => !e.name.startsWith("(idle)"));
  console.log("[zoom] heaviest self time:");
  for (const e of busy.slice(0, top)) {
    console.log(`    ${e.ms.toFixed(0).padStart(6)} ms  ${e.name}`);
  }
});
