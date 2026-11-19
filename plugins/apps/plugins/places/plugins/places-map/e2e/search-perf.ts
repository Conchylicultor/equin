// What a keystroke in the Places search bar costs ("Search or add places"),
// on THIS checkout's deploy (default: the website demo's Places,
// /about/demo/at/places — ~970 places; `--path /places` for the app's own data,
// `--url https://equin.ai/demo/at/places` for the public site).
//
// Types a query a character at a time, then selects it all and cuts it (Mod+X —
// the slow-interaction report's gesture), and prints each keystroke's Event
// Timing duration (input → next paint, what the slow-interaction report
// measures), the browser's work counters and the heaviest self time of a CPU
// profile over the whole run.
//
// Usage:
//   ./equin run plugins/apps/plugins/places/plugins/places-map/e2e/search-perf.ts \
//     [--path /about/demo/at/places] [--query paris] [--cpu 4] [--rounds 1] [--top 25] [--fiber-top 0]
//     [--field "Search or add places"]
//     [--no-profile] [--trace] [--out "$EQUIN_SCRATCH/search"]
//
// `--field` is the search field's placeholder, so the same run measures any
// DataView's search (`--path /agents/tasks --field "Search…"`: the Tasks list).
//
// `--rounds N` repeats the run and prints each step's median keystroke latency.
// With one round it also prints, per step, the React commits it caused and the
// components each rendered (from a devtools hook; `--fiber-top N` lists the N
// most rendered, `--out` writes each big commit's outline) and, with
// `--trace`, the main thread's time by trace event.
//
// Writes `<out>.cpuprofile` (Chrome DevTools → Performance).

import {
  arg,
  numArg,
  pageUrl,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { writeFileSync } from "node:fs";

const url = pageUrl(arg("path", "/about/demo/at/places"));
const query = arg("query", "paris");
const field = arg("field", "Search or add places");
const cpu = numArg("cpu", 4);
const top = numArg("top", 25);
const fiberTop = numArg("fiber-top", 0);
// Rounds of typing the query and cutting it: the summary is each step's
// median over them (one interaction's latency is noise on a loaded host).
const rounds = numArg("rounds", 1);
const out = arg("out", "/dev/null");
const profiling = !process.argv.includes("--no-profile");
// A Chrome trace of the run, split per step by main-thread event (script,
// style, layout, paint …) — what the "no JS" part of a keystroke is.
const tracing = process.argv.includes("--trace");

interface ProfileNode {
  id: number;
  callFrame: {
    functionName: string;
    url: string;
    lineNumber: number;
    columnNumber: number;
  };
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
    const { functionName, url: u, lineNumber, columnNumber } = node.callFrame;
    const file = u.split("/").slice(-2).join("/");
    const key = `${functionName || "(anonymous)"} ${file}:${lineNumber + 1}:${columnNumber + 1}`;
    ms.set(key, (ms.get(key) ?? 0) + (deltas[i] ?? 0) / 1000);
  }
  return [...ms.entries()]
    .map(([name, v]) => ({ name, ms: v }))
    .sort((a, b) => b.ms - a.ms);
}

interface Timing {
  name: string;
  key: string;
  duration: number;
  input: number;
  processing: number;
  presentation: number;
}

interface TraceEvent {
  name: string;
  ph: string;
  ts: number;
  dur?: number;
  tid: number;
  pid: number;
  args?: { data?: { type?: string } };
}

/** The median of `xs` (0 for none). */
function median(xs: readonly number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/** Per step: the renderer main thread's self time by event name. */
function printTrace(buf: Buffer): void {
  const perStep = new Map<
    string,
    { input: number[]; longest: number[]; total: number[] }
  >();
  if (out !== "/dev/null") writeFileSync(`${out}.trace.json`, buf);
  const { traceEvents } = JSON.parse(buf.toString()) as {
    traceEvents: TraceEvent[];
  };
  const marks = traceEvents
    .filter((e) => e.name.startsWith("sp:") && e.ph !== "X")
    .sort((a, b) => a.ts - b.ts);
  const main = marks[0];
  if (main === undefined) throw new Error("no step marks in the trace");
  const complete = traceEvents
    .filter(
      (e) =>
        e.ph === "X" &&
        e.dur !== undefined &&
        e.pid === main.pid &&
        e.tid === main.tid,
    )
    .sort((a, b) => a.ts - b.ts || (b.dur ?? 0) - (a.dur ?? 0));
  for (let i = 0; i + 1 < marks.length; i++) {
    const from = marks[i]!.ts;
    const to = marks[i + 1]!.ts;
    const self = new Map<string, number>();
    const stack: { e: TraceEvent; child: number }[] = [];
    const close = (upTo: number) => {
      while (stack.length > 0) {
        const t = stack[stack.length - 1]!;
        if (t.e.ts + (t.e.dur ?? 0) > upTo) break;
        stack.pop();
        self.set(
          t.e.name,
          (self.get(t.e.name) ?? 0) + ((t.e.dur ?? 0) - t.child) / 1000,
        );
      }
    };
    let total = 0;
    for (const e of complete) {
      if (e.ts < from || e.ts >= to) continue;
      close(e.ts);
      if (stack.length > 0) stack[stack.length - 1]!.child += e.dur ?? 0;
      else total += (e.dur ?? 0) / 1000;
      stack.push({ e, child: 0 });
    }
    close(Infinity);
    // The task the keystroke's own events ran in (keydown … input): what
    // blocks the main thread before the frame can show the key.
    const tops = complete.filter(
      (e) => e.ts >= from && e.ts < to && e.name === "RunTask",
    );
    const inputTask = tops.find((t) =>
      complete.some(
        (e) =>
          e.name === "EventDispatch" &&
          (e.args?.data?.type === "input" ||
            e.args?.data?.type === "keydown") &&
          e.ts >= t.ts &&
          e.ts < t.ts + (t.dur ?? 0),
      ),
    );
    const longest = Math.max(0, ...tops.map((t) => t.dur ?? 0)) / 1000;
    const step = marks[i]!.name.slice(3);
    const row = perStep.get(step) ?? { input: [], longest: [], total: [] };
    row.input.push((inputTask?.dur ?? 0) / 1000);
    row.longest.push(longest);
    row.total.push(total);
    perStep.set(step, row);
    if (rounds > 1) continue;
    console.log(
      `[trace] ${step}: main thread ${total.toFixed(0)} ms, the keystroke's task ${((inputTask?.dur ?? 0) / 1000).toFixed(0)} ms, longest task ${longest.toFixed(0)} ms`,
    );
    for (const [name, ms] of [...self.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8))
      if (ms >= 1) console.log(`    ${ms.toFixed(0).padStart(6)} ms  ${name}`);
  }
  if (rounds === 1) return;
  const all = {
    input: [] as number[],
    longest: [] as number[],
    total: [] as number[],
  };
  for (const [step, row] of perStep) {
    all.input.push(...row.input);
    all.longest.push(...row.longest);
    all.total.push(...row.total);
    console.log(
      `[trace] ${step.padEnd(18)} median: keystroke's task ${median(row.input).toFixed(0).padStart(4)} ms · longest task ${median(row.longest).toFixed(0).padStart(4)} ms · main thread ${median(row.total).toFixed(0).padStart(4)} ms`,
    );
  }
  console.log(
    `[trace] every keystroke      median: keystroke's task ${median(all.input).toFixed(0).padStart(4)} ms · longest task ${median(all.longest).toFixed(0).padStart(4)} ms · main thread ${median(all.total).toFixed(0).padStart(4)} ms`,
  );
}

const METRICS = [
  "TaskDuration",
  "ScriptDuration",
  "RecalcStyleDuration",
  "LayoutDuration",
  "RecalcStyleCount",
  "LayoutCount",
] as const;

await withBrowser(async (h) => {
  const { page } = await h.session({
    viewport: { width: 1440, height: 900 },
    colorScheme: "light",
  });
  // Which components render per step: a devtools hook tallies, per commit,
  // every component fiber that did work (React's PerformedWork flag) — on a
  // fiber object the commit before did not hold, since a subtree that bailed
  // out whole keeps its old fibers, flags and all.
  await page.addInitScript(() => {
    const w = window as unknown as {
      __spCommits: {
        names: Record<string, number>;
        roots: Record<string, number>;
        total: number;
        mounted: number;
        outline: string[];
      }[];
      __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown;
    };
    w.__spCommits = [];
    interface Fiber {
      tag: number;
      flags: number;
      type: unknown;
      child: Fiber | null;
      sibling: Fiber | null;
      alternate: Fiber | null;
    }
    const nameOf = (t: unknown): string => {
      if (typeof t === "function")
        return (
          (t as { displayName?: string; name: string }).displayName ?? t.name
        );
      if (t !== null && typeof t === "object") {
        const o = t as {
          displayName?: string;
          render?: unknown;
          type?: unknown;
        };
        return o.displayName ?? nameOf(o.render ?? o.type);
      }
      return "?";
    };
    const seen = new WeakMap<object, WeakSet<Fiber>>();
    w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true,
      renderers: new Map(),
      inject: () => 1,
      checkDCE: () => {},
      onScheduleFiberRoot: () => {},
      onCommitFiberUnmount: () => {},
      onPostCommitFiberRoot: () => {},
      onCommitFiberRoot: (_id: number, root: { current: Fiber }) => {
        const prev = seen.get(root) ?? new WeakSet<Fiber>();
        const now = new WeakSet<Fiber>();
        seen.set(root, now);
        const names: Record<string, number> = {};
        const roots: Record<string, number> = {};
        let total = 0;
        // Rendered for the first time (no previous fiber to update): a row
        // a new result mounted, as opposed to one that re-rendered.
        let mounted = 0;
        // Each fiber with whether a component above it rendered: the top-most
        // rendered components are the commit's roots — what set it off.
        const outline: string[] = [];
        const stack: [Fiber, boolean, number][] = [[root.current, false, 0]];
        while (stack.length > 0) {
          const [f, under, depth] = stack.pop()!;
          now.add(f);
          let rendered = false;
          if (
            [0, 1, 11, 14, 15].includes(f.tag) &&
            (f.flags & 1) !== 0 &&
            !prev.has(f)
          ) {
            const n = nameOf(f.type) || "(anonymous)";
            names[n] = (names[n] ?? 0) + 1;
            if (!under) roots[n] = (roots[n] ?? 0) + 1;
            if (outline.length < 1500)
              outline.push(`${" ".repeat(Math.min(depth, 60))}${n}`);
            total++;
            if (f.alternate === null) mounted++;
            rendered = true;
          }
          if (f.sibling) stack.push([f.sibling, under, depth]);
          if (f.child)
            stack.push([
              f.child,
              under || rendered,
              depth + (rendered ? 1 : 0),
            ]);
        }
        w.__spCommits.push({ names, roots, total, mounted, outline });
      },
    };
  });
  await page.goto(url, { waitUntil: "commit" });
  const input = page.getByPlaceholder(field);
  await input.waitFor({ timeout: 180_000 });
  await page.waitForTimeout(6000);
  console.log(`page: ${url}  cpu x${cpu}  query "${query}"`);
  await page.evaluate(() => {
    const w = window as unknown as { __sp: Timing[] };
    w.__sp = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as PerformanceEventTiming[])
        if (e.name === "keydown" || e.name === "input" || e.name === "keyup")
          w.__sp.push({
            name: e.name,
            key: "",
            duration: e.duration,
            input: e.processingStart - e.startTime,
            processing: e.processingEnd - e.processingStart,
            presentation: e.startTime + e.duration - e.processingEnd,
          });
    }).observe({
      type: "event",
      durationThreshold: 16,
    } as PerformanceObserverInit);
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const metrics = async (): Promise<Record<string, number>> => {
    const { metrics: all } = (await cdp.send("Performance.getMetrics")) as {
      metrics: { name: string; value: number }[];
    };
    return Object.fromEntries(all.map((m) => [m.name, m.value]));
  };
  if (profiling) {
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: 500 });
  }
  await input.click();
  await page.waitForTimeout(1500);
  if (cpu > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu });
  const before = await metrics();
  if (profiling) await cdp.send("Profiler.start");

  const browser = page.context().browser();
  if (tracing) {
    if (browser === null) throw new Error("no browser to trace");
    await browser.startTracing(page, {
      categories: [
        "devtools.timeline",
        "disabled-by-default-devtools.timeline",
        "blink.user_timing",
      ],
    });
  }
  const mark = (name: string) =>
    page.evaluate((n) => performance.mark(n), name);
  const steps: string[] = [];
  const read = async () =>
    (await page.evaluate(() =>
      (window as unknown as { __sp: Timing[] }).__sp.splice(0),
    )) as Timing[];
  const results: { step: string; timings: Timing[] }[] = [];
  const commits = async (step: string) => {
    const all = await page.evaluate(() =>
      (
        window as unknown as {
          __spCommits: {
            names: Record<string, number>;
            roots: Record<string, number>;
            total: number;
            mounted: number;
            outline: string[];
          }[];
        }
      ).__spCommits.splice(0),
    );
    if (rounds > 1) return;
    const names: Record<string, number> = {};
    for (const c of all)
      for (const [n, k] of Object.entries(c.names))
        names[n] = (names[n] ?? 0) + k;
    console.log(
      `[fibers] ${step}: ${all.length} commits, ${all.map((c) => c.total).join(" + ")} components rendered (${all.reduce((n, c) => n + c.mounted, 0)} of them mounted)`,
    );
    if (out !== "/dev/null")
      all.forEach((c, i) => {
        if (c.total >= 50)
          writeFileSync(
            `${out}-${step.replace(/[^a-z0-9]+/gi, "_")}-${i}.outline.txt`,
            c.outline.join("\n"),
          );
      });
    for (const c of all)
      if (c.total >= 50)
        console.log(
          `    commit of ${c.total} (${c.mounted} mounted) from ${Object.entries(
            c.roots,
          )
            .map(([n, k]) => (k > 1 ? `${n}×${k}` : n))
            .join(", ")}`,
        );
    for (const [n, k] of Object.entries(names)
      .sort((a, b) => b[1] - a[1])
      .slice(0, fiberTop))
      console.log(`    ${String(k).padStart(5)}  ${n}`);
  };
  await commits("before");
  for (let round = 0; round < rounds; round++) {
    for (const ch of query) {
      await mark(`sp:type "${ch}"`);
      await page.keyboard.press(ch);
      await page.waitForTimeout(1500);
      steps.push(`type "${ch}"`);
      await commits(`type "${ch}"`);
      results.push({ step: `type "${ch}"`, timings: await read() });
    }
    await page.keyboard.press("ControlOrMeta+A");
    await page.waitForTimeout(500);
    await read();
    await commits("select all");
    await mark("sp:cut all (Mod+X)");
    await page.keyboard.press("ControlOrMeta+X");
    await page.waitForTimeout(2500);
    results.push({ step: "cut all (Mod+X)", timings: await read() });
    await commits("cut all (Mod+X)");
  }
  const profile = profiling
    ? ((await cdp.send("Profiler.stop")) as { profile: Profile }).profile
    : null;
  await mark("sp:end");
  const after = await metrics();
  if (tracing && browser !== null) printTrace(await browser.stopTracing());
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });

  const byStep = new Map<string, number[]>();
  for (const r of results) {
    const worst = r.timings.sort((a, b) => b.duration - a.duration)[0];
    const list = byStep.get(r.step) ?? [];
    list.push(worst?.duration ?? 0);
    byStep.set(r.step, list);
    if (rounds === 1)
      console.log(
        `${r.step.padEnd(18)} ${
          worst === undefined
            ? "< 16 ms"
            : `${worst.duration.toFixed(0).padStart(5)} ms (${worst.name}: input ${worst.input.toFixed(0)}, processing ${worst.processing.toFixed(0)}, presentation ${worst.presentation.toFixed(0)})`
        }`,
      );
  }
  if (rounds > 1) {
    const all: number[] = [];
    for (const [step, xs] of byStep) {
      all.push(...xs);
      console.log(
        `${step.padEnd(18)} median ${median(xs).toFixed(0).padStart(4)} ms  (${xs.map((x) => x.toFixed(0)).join(" ")}; 0 = under 16 ms)`,
      );
    }
    console.log(
      `every keystroke     median ${median(all).toFixed(0).padStart(4)} ms, worst ${Math.max(...all).toFixed(0)} ms, ${all.length} interactions`,
    );
  }
  for (const m of METRICS) {
    const d = (after[m] ?? 0) - (before[m] ?? 0);
    console.log(
      `  ${m.padEnd(20)} ${m.endsWith("Duration") ? `${(d * 1000).toFixed(0)} ms` : d}`,
    );
  }
  if (profile === null) return;
  if (out !== "/dev/null")
    writeFileSync(`${out}.cpuprofile`, JSON.stringify(profile));
  console.log("heaviest self time (throttled ms):");
  for (const e of selfTimes(profile)
    .filter((e) => !e.name.startsWith("(idle)"))
    .slice(0, top))
    console.log(`  ${e.ms.toFixed(0).padStart(6)} ms  ${e.name}`);
});
