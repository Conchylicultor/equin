/**
 * What an IN-APP open of a conversation costs the main thread, split by kind of
 * work: script (React render + commit, our own JS), style, layout (forced inside
 * script vs the frame's own), paint (pre-paint, paint, layerize, commit) and GC —
 * read from a Chrome trace (devtools.timeline), thread CPU time per event, self
 * time only. Also counts what the open mounted: transcript rows, elements under
 * the scroller, and how many of each are on screen.
 *
 * The page boots on `--from` (another conversation), then each run navigates
 * in-app (pushState + popstate, as a click on a session row does) to `--conv`,
 * settles, and navigates back. Run 1 opens on data fetched from the server; the
 * later runs reopen a transcript the tab already holds — the session-row click
 * the slow-interaction reports were filed from. Prints the median of the
 * reopens, the longest task (the open's commit) split the same way, and with
 * `--cpu` a sampled CPU profile's JS self time by module and by function.
 *
 *   ./equin run plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/e2e/open-split.ts \
 *     --conv <id> --from <id> [--runs 4] [--settle-ms 2500] [--cpu] [--no-record]
 */
import {
  arg,
  flag,
  numArg,
  pathUrl,
  report,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import type { CDPSession, Page } from "playwright";
import { z } from "zod";

const convId = arg("conv", "");
const fromId = arg("from", "");
const runs = numArg("runs", 4);
const settleMs = numArg("settle-ms", 2500);
const cpu = flag("cpu");

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
  "v8.execute",
  "v8",
].join(",");

/** Which bucket one trace event's self time is charged to. */
function bucketOf(name: string, inScript: boolean): string {
  if (name === "Layout") return inScript ? "layout (forced)" : "layout";
  if (name === "UpdateLayoutTree" || name === "RecalculateStyles")
    return inScript ? "style (forced)" : "style";
  if (
    name === "Paint" ||
    name === "PrePaint" ||
    name === "Layerize" ||
    name === "UpdateLayer" ||
    name === "UpdateLayerTree" ||
    name === "Commit" ||
    name === "CompositeLayers" ||
    name === "PaintImage" ||
    name === "IntersectionObserverController::computeIntersections" ||
    name === "ScrollLayer"
  )
    return "paint";
  if (/GC|Scavenge|MarkCompact|MinorMS/.test(name)) return "gc";
  if (
    name === "FunctionCall" ||
    name === "EvaluateScript" ||
    name === "v8.compile" ||
    name === "v8.compileModule" ||
    name === "v8.evaluateModule" ||
    name === "TimerFire" ||
    name === "FireAnimationFrame" ||
    name === "EventDispatch" ||
    name === "RunMicrotasks" ||
    name === "V8.Execute" ||
    name.startsWith("v8.")
  )
    return "script";
  if (name === "ParseHTML" || name === "ParseAuthorStyleSheet") return "parse";
  if (name === "RunTask" || name === "ThreadControllerImpl::RunTask")
    return "other (task)";
  return `other: ${name}`;
}

const SCRIPT_ROOTS = new Set([
  "FunctionCall",
  "EvaluateScript",
  "TimerFire",
  "FireAnimationFrame",
  "EventDispatch",
  "RunMicrotasks",
  "V8.Execute",
]);

interface Split {
  total: number;
  buckets: Map<string, number>;
  byName: Map<string, number>;
  longest: number;
  /** The longest task (the open's commit), split the same way. */
  longestBuckets: Map<string, number>;
  /** CPU of every task over 16 ms (a frame's budget): what the reader waits through. */
  blocking: number;
}

function split(events: TraceEvent[]): Split {
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
  const buckets = new Map<string, number>();
  const byName = new Map<string, number>();
  const perTask = new Map<TraceEvent, Map<string, number>>();
  const stack: { e: TraceEvent; child: number; inScript: boolean }[] = [];
  const close = (upTo: number) => {
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      if (top.e.ts + (top.e.dur ?? 0) > upTo) break;
      stack.pop();
      const self = Math.max(0, (top.e.tdur ?? top.e.dur ?? 0) - top.child);
      const parentScript = stack.some((s) => SCRIPT_ROOTS.has(s.e.name));
      const b = bucketOf(top.e.name, parentScript);
      buckets.set(b, (buckets.get(b) ?? 0) + self);
      byName.set(top.e.name, (byName.get(top.e.name) ?? 0) + self);
      const root = stack[0]?.e ?? top.e;
      const per = perTask.get(root) ?? new Map<string, number>();
      per.set(b, (per.get(b) ?? 0) + self);
      perTask.set(root, per);
    }
  };
  for (const e of onMain) {
    close(e.ts);
    if (stack.length > 0)
      stack[stack.length - 1]!.child += e.tdur ?? e.dur ?? 0;
    stack.push({ e, child: 0, inScript: false });
  }
  close(Infinity);
  const tasks = onMain.filter((e) => e.name === "RunTask");
  const cpuOf = (t: TraceEvent) => t.tdur ?? t.dur ?? 0;
  const top = [...tasks].sort((a, b) => cpuOf(b) - cpuOf(a))[0];
  return {
    longestBuckets: (top && perTask.get(top)) ?? new Map(),
    blocking: tasks
      .filter((t) => cpuOf(t) > 16_000)
      .reduce((n, t) => n + cpuOf(t), 0),
    total: tasks.reduce((n, t) => n + (t.tdur ?? t.dur ?? 0), 0),
    buckets,
    byName,
    longest: Math.max(0, ...tasks.map((t) => t.tdur ?? t.dur ?? 0)),
  };
}

async function trace(cdp: CDPSession, act: () => Promise<void>) {
  const collected: TraceEvent[] = [];
  const onData = (e: { value: Record<string, unknown>[] }) => {
    for (const raw of e.value) collected.push(TraceEventSchema.parse(raw));
  };
  cdp.on("Tracing.dataCollected", onData);
  const done = new Promise<void>((resolve) =>
    cdp.once("Tracing.tracingComplete", () => resolve()),
  );
  await cdp.send("Tracing.start", {
    categories: CATEGORIES,
    transferMode: "ReportEvents",
  });
  await act();
  await cdp.send("Tracing.end");
  await done;
  cdp.off("Tracing.dataCollected", onData);
  return collected;
}

async function go(page: Page, id: string) {
  await page.evaluate((path: string) => {
    window.history.pushState(null, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, `/agents/c/${id}`);
}

/** The transcript scroller of the conversation on screen, and what it holds. */
async function mounted(page: Page) {
  return page.evaluate(() => {
    const scroller = [...document.querySelectorAll("[data-pane-scroll]")].find(
      (s) => s.querySelector("[data-event-key]"),
    );
    if (!scroller) return null;
    const view = scroller.getBoundingClientRect();
    const onScreen = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.bottom > view.top && r.top < view.bottom && r.height > 0;
    };
    const rows = [...scroller.querySelectorAll("[data-event-key]")];
    const all = [...scroller.querySelectorAll("*")];
    return {
      rows: rows.length,
      rowsOnScreen: rows.filter(onScreen).length,
      elements: all.length,
      elementsOnScreen: all.filter(onScreen).length,
      contentPx: Math.round(scroller.scrollHeight),
      viewportPx: Math.round(view.height),
    };
  });
}

const ms = (us: number) => `${(us / 1000).toFixed(0)} ms`;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
};

/** A V8 CPU profile's self time per script URL (the plugin artifact a module came from). */
interface CpuProfile {
  nodes: {
    id: number;
    callFrame: { functionName: string; url: string };
  }[];
  samples?: number[];
  timeDeltas?: number[];
}
function selfByModule(p: CpuProfile, byFunction = false): Map<string, number> {
  const byId = new Map(p.nodes.map((n) => [n.id, n] as const));
  const out = new Map<string, number>();
  const samples = p.samples ?? [];
  const deltas = p.timeDeltas ?? [];
  for (let i = 0; i < samples.length; i++) {
    const n = byId.get(samples[i]!);
    if (!n) continue;
    const url = n.callFrame.url;
    const key =
      url === ""
        ? `(${n.callFrame.functionName || "native"})`
        : (/\/(?:artifacts|assets|vendor)\/([^?#]+)/.exec(url)?.[1] ?? url)
            .split("/")
            .slice(0, 3)
            .join("/");
    const k2 = byFunction
      ? `${n.callFrame.functionName || "(anon)"}  ${key}`
      : key;
    out.set(k2, (out.get(k2) ?? 0) + (deltas[i] ?? 0));
  }
  return out;
}

await withBrowser(async (h) => {
  const r = report("conversation open split");
  if (convId === "" || fromId === "") r.fail("args", "pass --conv and --from");
  const { page } = await h.session();
  await page.goto(pathUrl(`/agents/c/${fromId}`));
  await page.waitForSelector("[data-event-key]", { timeout: 90_000 });
  await page.waitForTimeout(settleMs * 2);
  const cdp = await page.context().newCDPSession(page);
  const cached: Split[] = [];
  const modules = new Map<string, number[]>();
  const functions = new Map<string, number[]>();
  for (let run = 1; run <= runs; run++) {
    const profiling = cpu && run > 1;
    if (profiling) {
      await cdp.send("Profiler.enable");
      await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
      await cdp.send("Profiler.start");
    }
    const events = await trace(cdp, async () => {
      await go(page, convId);
      await page.waitForFunction(
        (id: string) =>
          location.pathname.endsWith(id) &&
          document.querySelector("[data-event-key]") !== null,
        convId,
        { timeout: 60_000 },
      );
      await page.waitForTimeout(settleMs);
    });
    if (profiling) {
      const { profile } = (await cdp.send("Profiler.stop")) as {
        profile: CpuProfile;
      };
      for (const [k, us] of selfByModule(profile))
        modules.set(k, [...(modules.get(k) ?? []), us]);
      for (const [k, us] of selfByModule(profile, true))
        functions.set(k, [...(functions.get(k) ?? []), us]);
    }
    const s = split(events);
    if (run > 1) cached.push(s);
    const m = await mounted(page);
    const parts = [...s.buckets.entries()]
      .filter(([, us]) => us >= 1000)
      .sort((a, b) => b[1] - a[1])
      .map(([b, us]) => `${b} ${ms(us)}`)
      .join(" · ");
    r.note(
      `run ${run}${run === 1 ? " (fetched)" : " (cached)"}: main thread ${ms(s.total)} (longest task ${ms(s.longest)}) — ${parts}`,
    );
    if (m)
      r.note(
        `  mounted ${m.rows} rows / ${m.elements} elements; on screen ${m.rowsOnScreen} rows / ${m.elementsOnScreen} elements; ${m.contentPx} px content in ${m.viewportPx} px`,
      );
    r.ok(`run ${run} drew the transcript`, m !== null && m.rows > 0);
    await go(page, fromId);
    await page.waitForTimeout(settleMs);
  }
  if (cached.length > 0) {
    const keys = new Set(cached.flatMap((s) => [...s.buckets.keys()]));
    const med = [...keys]
      .map(
        (k) => [k, median(cached.map((s) => s.buckets.get(k) ?? 0))] as const,
      )
      .filter(([, us]) => us >= 500)
      .sort((a, b) => b[1] - a[1]);
    r.note(
      `median of ${cached.length} cached opens: main thread ${ms(median(cached.map((s) => s.total)))}, longest task ${ms(median(cached.map((s) => s.longest)))} — ${med.map(([k, us]) => `${k} ${ms(us)}`).join(" · ")}`,
    );
    const names = new Set(cached.flatMap((s) => [...s.byName.keys()]));
    const top = [...names]
      .map((k) => [k, median(cached.map((s) => s.byName.get(k) ?? 0))] as const)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 14);
    const lk = new Set(cached.flatMap((s) => [...s.longestBuckets.keys()]));
    const lmed = [...lk]
      .map(
        (k) =>
          [k, median(cached.map((s) => s.longestBuckets.get(k) ?? 0))] as const,
      )
      .filter(([, us]) => us >= 500)
      .sort((a, b) => b[1] - a[1]);
    r.note(
      `  longest task: ${lmed.map(([k, us]) => `${k} ${ms(us)}`).join(" · ")}; tasks over 16 ms: ${ms(median(cached.map((s) => s.blocking)))} in total`,
    );
    r.note(
      `  by trace event:${top.map(([k, us]) => `${k} ${ms(us)}`).join(" · ")}`,
    );
  }
  if (modules.size > 0) {
    const top = [...modules.entries()]
      .map(([k, xs]) => [k, median(xs)] as const)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20);
    r.note("  JS self time by module (median, sampled):");
    for (const [k, us] of top) r.note(`    ${ms(us).padStart(7)}  ${k}`);
    r.note("  JS self time by function (median, sampled):");
    for (const [k, us] of [...functions.entries()]
      .map(([k, xs]) => [k, median(xs)] as const)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30))
      r.note(`    ${ms(us).padStart(7)}  ${k}`);
  }
  await r.finish();
});
