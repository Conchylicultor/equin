// What opening a page beside a conversation (conversation/page-detail) costs
// the main thread — the in-app open, not the boot: boots on the conversation,
// waits for it to settle, then client-navigates to /page/<block> while a CPU
// profile and a devtools.timeline trace record. Prints the long animation
// frames (script, forced style/layout), the main thread's style/layout totals
// and every recalc over 10 ms (with how many styles it computed), the
// functions by self time, the stacks of chosen functions (`--stacks a,b`) and
// components/hooks by inclusive time; writes `<out>.cpuprofile`.
//
// Usage (a long page shows the per-block costs):
//   ./equin run plugins/page/plugins/editor/e2e/open-in-conversation-profile.ts \
//     --conv <conv-id> --block <page-block-id> --out "$EQUIN_SCRATCH/open" \
//     [--seconds 6] [--top 40] [--itop 60] [--stacks getBoundingClientRect]
import {
  arg,
  numArg,
  pathUrl,
  requireArg,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { writeFileSync } from "node:fs";

const USAGE =
  "open-in-conversation-profile.ts --conv <conv-id> --block <page-block-id> --out <path>";
const conv = requireArg("conv", USAGE);
const block = requireArg("block", USAGE);
const out = requireArg("out", USAGE);
const secs = numArg("seconds", 6);

type Node = {
  id: number;
  callFrame: {
    functionName: string;
    url: string;
    lineNumber: number;
    columnNumber: number;
  };
  children?: number[];
};
type Profile = {
  nodes: Node[];
  samples: number[];
  timeDeltas: number[];
  startTime: number;
  endTime: number;
};

await withBrowser(async (h) => {
  const { page } = await h.session();
  await page.goto(pathUrl(`/agents/c/${conv}`), { waitUntil: "load" });
  await page.waitForTimeout(8000);
  await page.evaluate(() => {
    (window as unknown as { __loaf: unknown[] }).__loaf = [];
    new PerformanceObserver((l) => {
      for (const e of l.getEntries())
        (window as unknown as { __loaf: unknown[] }).__loaf.push({
          d: e.duration,
          s: e.startTime,
          scripts: (
            (
              e as unknown as {
                scripts: {
                  invoker: string;
                  duration: number;
                  sourceFunctionName: string;
                  forcedStyleAndLayoutDuration: number;
                }[];
              }
            ).scripts ?? []
          ).map((s) => ({
            inv: s.invoker,
            d: s.duration,
            fn: s.sourceFunctionName,
            forced: s.forcedStyleAndLayoutDuration,
          })),
          styleAndLayoutStart: (e as unknown as { styleAndLayoutStart: number })
            .styleAndLayoutStart,
          renderStart: (e as unknown as { renderStart: number }).renderStart,
        });
    }).observe({ type: "long-animation-frame", buffered: false });
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 100 });
  await cdp.send("Profiler.start");
  const traceEvents: {
    name: string;
    ph: string;
    ts: number;
    dur?: number;
    tdur?: number;
    tid: number;
    pid: number;
    args?: { data?: { stackTrace?: unknown[] } };
  }[] = [];
  cdp.on("Tracing.dataCollected", (e) => {
    for (const r of e.value) traceEvents.push(r as never);
  });
  const traceDone = new Promise<void>((r) =>
    cdp.once("Tracing.tracingComplete", () => r()),
  );
  await cdp.send("Tracing.start", {
    categories: "devtools.timeline,disabled-by-default-devtools.timeline",
    transferMode: "ReportEvents",
  });
  const t0 = Date.now();
  await page.evaluate((b) => {
    const url = location.pathname.replace(/\/$/, "") + `/page/${b}`;
    history.pushState(null, "", url);
    dispatchEvent(new PopStateEvent("popstate"));
  }, block);
  await page.waitForTimeout(secs * 1000);
  await cdp.send("Tracing.end");
  await traceDone;
  {
    const main = traceEvents
      .filter(
        (e) =>
          e.name === "thread_name" &&
          (e as unknown as { args?: { name?: string } }).args?.name ===
            "CrRendererMainThread",
      )
      .map((m) => ({
        m,
        n: traceEvents.filter((e) => e.tid === m.tid && e.ph === "X").length,
      }))
      .sort((a, b) => b.n - a.n)[0]?.m;
    const byTid = new Map<number, number>();
    for (const e of traceEvents)
      if (e.name === "UpdateLayoutTree")
        byTid.set(e.tid, (byTid.get(e.tid) ?? 0) + 1);
    const tid = main?.tid ?? [...byTid].sort((a, b) => b[1] - a[1])[0]?.[0];
    const sums = new Map<string, { n: number; ms: number }>();
    for (const e of traceEvents) {
      if (e.ph !== "X" || e.tid !== tid || e.dur === undefined) continue;
      if (
        ![
          "UpdateLayoutTree",
          "Layout",
          "FunctionCall",
          "TimerFire",
          "Paint",
          "PrePaint",
          "Layerize",
          "RunTask",
          "EvaluateScript",
          "v8.callFunction",
        ].includes(e.name)
      )
        continue;
      const k = e.name;
      const s0 = sums.get(k) ?? { n: 0, ms: 0 };
      s0.n++;
      s0.ms += e.dur / 1000;
      sums.set(k, s0);
    }
    console.log("TRACE (main thread):");
    for (const [k, v] of [...sums].sort((a, b) => b[1].ms - a[1].ms))
      console.log(
        `  ${k.padEnd(18)} n=${String(v.n).padStart(5)}  ${v.ms.toFixed(0)} ms`,
      );
    const big = traceEvents.filter(
      (e) =>
        e.tid === tid &&
        e.ph === "X" &&
        (e.name === "Layout" || e.name === "UpdateLayoutTree") &&
        (e.dur ?? 0) > 10000,
    );
    for (const e of big)
      console.log(
        `  big ${e.name} ${((e.dur ?? 0) / 1000).toFixed(0)} ms args=${JSON.stringify((e as unknown as { args: unknown }).args).slice(0, 300)} forced=${Boolean(e.args?.data?.stackTrace ?? (e as unknown as { args?: { beginData?: { stackTrace?: unknown } } }).args?.beginData?.stackTrace)}  ${JSON.stringify((e as unknown as { args?: { beginData?: { stackTrace?: { functionName: string }[] } } }).args?.beginData?.stackTrace?.slice(0, 3).map((f) => f.functionName) ?? e.args?.data?.stackTrace?.slice(0, 3) ?? "")}`,
      );
  }
  const { profile } = (await cdp.send("Profiler.stop")) as unknown as {
    profile: Profile;
  };
  console.log(`profiled ${Date.now() - t0} ms; url ${page.url()}`);
  writeFileSync(`${out}.cpuprofile`, JSON.stringify(profile));
  const loaf = await page.evaluate(
    () => (window as unknown as { __loaf: { d: number }[] }).__loaf,
  );
  console.log("LoAF frames:");
  for (const f of loaf as {
    d: number;
    s: number;
    renderStart: number;
    styleAndLayoutStart: number;
    scripts: { inv: string; d: number; fn: string; forced: number }[];
  }[]) {
    console.log(
      `  ${f.d.toFixed(0)} ms @${f.s.toFixed(0)} render@+${(f.renderStart - f.s).toFixed(0)} style@+${(f.styleAndLayoutStart - f.s).toFixed(0)}  ${f.scripts
        .slice(0, 3)
        .map(
          (s) =>
            `${s.fn}(${s.inv}) ${s.d.toFixed(0)}ms forced ${s.forced.toFixed(0)}`,
        )
        .join(" | ")}`,
    );
  }
  const els = await page.evaluate(() => document.querySelectorAll("*").length);
  const eds = await page.evaluate(
    () => document.querySelectorAll("[contenteditable]").length,
  );
  console.log(`elements ${els}, contenteditables ${eds}`);

  // self + inclusive time per function
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map<number, number>();
  for (const n of profile.nodes)
    for (const c of n.children ?? []) parent.set(c, n.id);
  const self = new Map<number, number>();
  profile.samples.forEach((s, i) =>
    self.set(s, (self.get(s) ?? 0) + (profile.timeDeltas[i] ?? 0)),
  );
  const key = (n: Node) =>
    `${n.callFrame.functionName || "(anon)"} ${n.callFrame.url.split("/").slice(-2).join("/")}:${n.callFrame.lineNumber}:${n.callFrame.columnNumber}`;
  const selfBy = new Map<string, number>();
  const inclBy = new Map<string, number>();
  for (const [id, us] of self) {
    const n = byId.get(id)!;
    selfBy.set(key(n), (selfBy.get(key(n)) ?? 0) + us);
    const seen = new Set<string>();
    let cur: number | undefined = id;
    while (cur !== undefined) {
      const k = key(byId.get(cur)!);
      if (!seen.has(k)) {
        seen.add(k);
        inclBy.set(k, (inclBy.get(k) ?? 0) + us);
      }
      cur = parent.get(cur);
    }
  }
  const top = (m: Map<string, number>, n: number) =>
    [...m]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([k, v]) => `  ${(v / 1000).toFixed(1).padStart(8)} ms  ${k}`)
      .join("\n");
  console.log("SELF:\n" + top(selfBy, numArg("top", 40)));
  for (const fn of arg(
    "stacks",
    "getBoundingClientRect,getComputedStyle",
  ).split(",")) {
    const paths = new Map<string, number>();
    for (const [id, us] of self) {
      const n = byId.get(id)!;
      if (n.callFrame.functionName !== fn) continue;
      const chain: string[] = [];
      let cur = parent.get(id);
      while (cur !== undefined && chain.length < 14) {
        const c = byId.get(cur)!;
        chain.push(
          `${c.callFrame.functionName || "(anon)"}@${c.callFrame.url.split("/").slice(-2, -1)[0]?.slice(0, 14)}:${c.callFrame.lineNumber}:${c.callFrame.columnNumber}`,
        );
        cur = parent.get(cur);
      }
      const k = chain.join(" < ");
      paths.set(k, (paths.get(k) ?? 0) + us);
    }
    for (const [k, v] of [...paths].sort((a, b) => b[1] - a[1]).slice(0, 4))
      console.log(`STACK ${fn} ${(v / 1000).toFixed(0)} ms: ${k}`);
  }
  const comp = new Map(
    [...inclBy].filter(([k]) => /^(use[A-Z]|[A-Z][a-z]\w{2,})/.test(k)),
  );
  console.log(
    "INCLUSIVE (components/hooks):\n" + top(comp, numArg("itop", 60)),
  );
});
