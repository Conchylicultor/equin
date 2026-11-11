/**
 * Tab-side memory-leak test: repeat a flow, force GC, diff heap snapshots.
 *
 * The three-snapshot technique, over CDP's HeapProfiler:
 *
 *   warm-up × W  →  GC, snapshot BASE
 *   flow × N     →  GC, snapshot MID
 *   flow × N     →  GC, snapshot END
 *
 * The first run absorbs what a flow allocates ONCE and keeps on purpose (a
 * lazily loaded module, a filled cache, a memoised query), so growth is
 * measured over the SECOND run, MID → END: a flow that leaks keeps growing
 * there, a flow that only warmed up does not. And because a heap object keeps
 * its id across snapshots of one tab (newer objects get higher ids), the
 * objects allocated during the first run that are STILL alive at END — the
 * "survivors" — are exactly what one run left behind; their retainer paths say
 * who holds them.
 *
 * What it measures is the page's main-thread heap (the JS heap and the Blink
 * objects it wraps). A SharedWorker or an iframe is another target with its
 * own heap, not covered.
 */
import type { CDPSession, Page } from "playwright";
import {
  closeSync,
  openSync,
  readFileSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { z } from "zod";
import {
  parseHeapSnapshot,
  type HeapGroup,
  type HeapGraph,
} from "./heap-snapshot";

/** One repetition of the flow under test. `i` counts from 0 across every run. */
export type LeakStep = (page: Page, i: number) => Promise<void>;

export interface LeakThresholds {
  /** Fail when the post-GC app heap (`LeakPhase.appBytes`) grows by more than this per iteration over the second run (bytes). */
  maxBytesPerIteration: number;
  /** Fail when detached DOM nodes grow by more than this per iteration over the second run. */
  maxDetachedPerIteration: number;
  /** Fail when JS event listeners grow by more than this per iteration over the second run. */
  maxListenersPerIteration: number;
}

export const DEFAULT_LEAK_THRESHOLDS: LeakThresholds = {
  maxBytesPerIteration: 50 * 1024,
  maxDetachedPerIteration: 1,
  maxListenersPerIteration: 1,
};

/** How a recorded run is read: thresholds and how much to print. */
export interface LeakAnalysisOptions {
  thresholds?: Partial<LeakThresholds>;
  /** Constructor rows to list. Default 15. */
  top?: number;
  /** Retainer paths to print. Default 5. */
  paths?: number;
}

export interface LeakTestOptions extends LeakAnalysisOptions {
  step: LeakStep;
  /** Iterations per measured run (there are two). Default 10. */
  iterations?: number;
  /** Untimed iterations before the baseline. Default 2. */
  warmup?: number;
  /** Wait before each GC, for timers / idle callbacks / transitions to drain (ms). Default 1000. */
  settleMs?: number;
  /** Path prefix: writes `<out>-{base,mid,end}.heapsnapshot` and `<out>-run.json`. */
  out: string;
}

export interface DomCounters {
  documents: number;
  nodes: number;
  jsEventListeners: number;
}

export interface LeakPhase {
  label: "base" | "mid" | "end";
  file: string;
  /** Sum of every heap node's self size (bytes). */
  heapBytes: number;
  /** The same, without V8 bookkeeping and inspector buffers (`isAppGroup`). */
  appBytes: number;
  heapNodes: number;
  detachedNodes: number;
  counters: DomCounters;
}

export interface GroupDelta {
  name: string;
  count: number;
  size: number;
}

export interface RetainerSample {
  group: string;
  /** Survivors of this group, of which this path is one. */
  count: number;
  /** How many objects the group gained over run 2. */
  grew: number;
  detached: boolean;
  path: string[];
}

export interface LeakReport {
  iterations: number;
  warmup: number;
  thresholds: LeakThresholds;
  phases: [LeakPhase, LeakPhase, LeakPhase];
  /** Per-constructor growth over the second run (MID → END), largest first. */
  growth: GroupDelta[];
  /** Detached DOM growth over the second run, by DOM class. */
  detachedGrowth: GroupDelta[];
  /** Objects allocated during the first run and still alive at END, by group. */
  survivors: HeapGroup[];
  retainers: RetainerSample[];
  verdict: {
    ok: boolean;
    checks: { name: string; ok: boolean; detail: string }[];
  };
  top: number;
}

/** V8 bookkeeping groups: they churn on their own and retain nothing of the app's. */
const INTERNAL_GROUPS = new Set([
  "(code)",
  "(compiled code)",
  "(hidden)",
  "(system)",
  "(synthetic)",
  "(object shape)",
  "(number)",
  "(symbol)",
  "(bigint)",
  "(extra native bytes)",
]);

/**
 * Not the app's memory: V8 bookkeeping (JIT code keeps growing as more of the
 * app gets optimised) and the inspector's own buffers (the Network domain the
 * harness enables keeps every response). Left out of the "app heap" figure
 * the verdict is judged on; still listed in the growth table.
 */
const isAppGroup = (name: string) =>
  !INTERNAL_GROUPS.has(name) && !name.startsWith("blink::NetworkResourcesData");

async function settleAndCollect(page: Page, cdp: CDPSession, settleMs: number) {
  await page.waitForTimeout(settleMs);
  // Twice: the first pass runs finalizers / weak callbacks that free more.
  await cdp.send("HeapProfiler.collectGarbage");
  await cdp.send("HeapProfiler.collectGarbage");
}

/** Stream a heap snapshot to `file`, chunk by chunk (a tab's can be GBs). */
async function takeSnapshot(cdp: CDPSession, file: string): Promise<void> {
  const fd = openSync(file, "w");
  // A failed write lands in an event handler: kept, and thrown from here.
  let writeError: unknown = null;
  const onChunk = (e: { chunk: string }) => {
    if (writeError !== null) return;
    try {
      writeSync(fd, e.chunk);
    } catch (err) {
      writeError = err;
    }
  };
  cdp.on("HeapProfiler.addHeapSnapshotChunk", onChunk);
  try {
    await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
  } finally {
    cdp.off("HeapProfiler.addHeapSnapshotChunk", onChunk);
    closeSync(fd);
  }
  if (writeError !== null)
    throw new Error(`leak test: writing ${file} failed`, { cause: writeError });
}

const snapshotFile = (out: string, label: LeakPhase["label"]) =>
  `${out}-${label}.heapsnapshot`;
const runFile = (out: string) => `${out}-run.json`;

/** What a run records beside its snapshots: enough to analyse it again later. */
const RunRecordSchema = z.object({
  iterations: z.number(),
  warmup: z.number(),
  counters: z.object({
    base: z.object({
      documents: z.number(),
      nodes: z.number(),
      jsEventListeners: z.number(),
    }),
    mid: z.object({
      documents: z.number(),
      nodes: z.number(),
      jsEventListeners: z.number(),
    }),
    end: z.object({
      documents: z.number(),
      nodes: z.number(),
      jsEventListeners: z.number(),
    }),
  }),
});
type RunRecord = z.infer<typeof RunRecordSchema>;

function diffGroups(
  a: Map<string, HeapGroup>,
  b: Map<string, HeapGroup>,
): GroupDelta[] {
  const out: GroupDelta[] = [];
  for (const name of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(name);
    const y = b.get(name);
    const count = (y?.count ?? 0) - (x?.count ?? 0);
    const size = (y?.size ?? 0) - (x?.size ?? 0);
    if (count !== 0 || size !== 0) out.push({ name, count, size });
  }
  return out.sort((p, q) => q.size - p.size || q.count - p.count);
}

/**
 * Run the leak test on `page`, already on the screen the flow starts from.
 * Writes `<out>-{base,mid,end}.heapsnapshot` and `<out>-run.json`, then
 * answers with `analyzeLeakRun(out)`; print it with `leakReportText`.
 */
export async function runLeakTest(
  page: Page,
  opts: LeakTestOptions,
): Promise<LeakReport> {
  const iterations = opts.iterations ?? 10;
  const warmup = opts.warmup ?? 2;
  const settleMs = opts.settleMs ?? 1000;
  if (iterations < 1)
    throw new Error(`leak test: iterations must be ≥ 1, got ${iterations}`);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("HeapProfiler.enable");
  let i = 0;
  const run = async (n: number, label: string) => {
    const t0 = Date.now();
    for (let k = 0; k < n; k += 1) await opts.step(page, i++);
    console.log(
      `leak-test: ${label} — ${n} iteration(s) in ${Date.now() - t0} ms`,
    );
  };
  const measure = async (label: LeakPhase["label"]): Promise<DomCounters> => {
    await settleAndCollect(page, cdp, settleMs);
    const c = await cdp.send("Memory.getDOMCounters");
    await takeSnapshot(cdp, snapshotFile(opts.out, label));
    return {
      documents: c.documents,
      nodes: c.nodes,
      jsEventListeners: c.jsEventListeners,
    };
  };

  let counters: RunRecord["counters"];
  try {
    await run(warmup, "warm-up");
    const base = await measure("base");
    await run(iterations, "run 1");
    const mid = await measure("mid");
    await run(iterations, "run 2");
    const end = await measure("end");
    counters = { base, mid, end };
  } finally {
    await cdp.detach();
  }

  const record: RunRecord = {
    iterations,
    warmup,
    counters,
  };
  writeFileSync(runFile(opts.out), JSON.stringify(record, null, 2));
  return analyzeLeakRun(opts.out, opts);
}

/**
 * Analyse a recorded run — the three snapshots and `<out>-run.json` that
 * `runLeakTest` wrote — without a browser: re-read a run with other
 * thresholds, more rows or more retainer paths.
 */
export function analyzeLeakRun(
  out: string,
  opts: LeakAnalysisOptions = {},
): LeakReport {
  const thresholds = { ...DEFAULT_LEAK_THRESHOLDS, ...opts.thresholds };
  const record = RunRecordSchema.parse(
    JSON.parse(readFileSync(runFile(out), "utf8")),
  );
  const { iterations } = record;
  const read = (label: LeakPhase["label"]) => {
    const file = snapshotFile(out, label);
    try {
      return parseHeapSnapshot(readFileSync(file, "utf8"));
    } catch (err) {
      throw new Error(
        `leak test: could not read ${file}: ${err instanceof Error ? err.message : String(err)}` +
          ` (a snapshot over ~512 MB exceeds the JS string limit — open that one in DevTools)`,
        { cause: err },
      );
    }
  };
  const phaseOf = (
    label: LeakPhase["label"],
    s: HeapGraph["summary"],
  ): LeakPhase => {
    let detachedNodes = 0;
    for (const g of s.detached.values()) detachedNodes += g.count;
    return {
      label,
      file: snapshotFile(out, label),
      heapBytes: s.totalSize,
      appBytes: [...s.groups.values()]
        .filter((g) => isAppGroup(g.name))
        .reduce((n, g) => n + g.size, 0),
      heapNodes: s.nodeCount,
      detachedNodes,
      counters: record.counters[label],
    };
  };
  // One graph at a time: only END's is kept, for its retainer paths.
  const baseSummary = read("base").summary;
  const midSummary = read("mid").summary;
  const graph = read("end");
  const phases: LeakReport["phases"] = [
    phaseOf("base", baseSummary),
    phaseOf("mid", midSummary),
    phaseOf("end", graph.summary),
  ];
  const [, mid, end] = phases;
  const growth = diffGroups(midSummary.groups, graph.summary.groups);

  const survivorGroups = new Map<string, HeapGroup>();
  const sample = new Map<string, number[]>();
  const detachedSample = new Map<string, number[]>();
  for (const n of graph.nodes()) {
    const id = graph.id(n);
    if (id <= baseSummary.maxId || id > midSummary.maxId) continue;
    const name = graph.group(n);
    const g = survivorGroups.get(name);
    if (g) {
      g.count += 1;
      g.size += graph.selfSize(n);
    } else
      survivorGroups.set(name, { name, count: 1, size: graph.selfSize(n) });
    const into = graph.isDetached(n) ? detachedSample : sample;
    const list = into.get(name) ?? [];
    if (list.length < 8) list.push(n);
    into.set(name, list);
  }
  const survivors = [...survivorGroups.values()].sort(
    (a, b) => b.size - a.size || b.count - a.count,
  );

  // Retainer paths, most suspect first: detached DOM (the classic tab leak),
  // then the groups that left survivors after run 1 AND kept growing over
  // run 2, by how many objects they gained, then the largest other survivor
  // groups. One path per group, deduplicated by its shape (ids stripped) so
  // ten identical chains print once.
  const wanted = opts.paths ?? 5;
  const grewBy = new Map(growth.map((g) => [g.name, g.count]));
  const retainers: RetainerSample[] = [];
  const seen = new Set<string>();
  const tried = new Set<string>();
  const tryGroup = (name: string, nodes: number[], detached: boolean) => {
    tried.add(name);
    for (const n of nodes) {
      const path = graph.retainerPath(n);
      if (!path) continue;
      // A detached subtree is one leak however many of its nodes are
      // sampled: keyed by its outermost detached node. Anything else by the
      // path's shape, ids stripped, so ten identical chains print once.
      const shape = detached
        ? (/ @\d+/.exec(
            path.find((step) => step.startsWith("Detached ")) ?? "",
          )?.[0] ?? path.join("|"))
        : path.map((step) => step.replace(/ @\d+/g, "")).join("|");
      if (seen.has(shape)) return;
      seen.add(shape);
      retainers.push({
        group: name,
        count: survivorGroups.get(name)?.count ?? nodes.length,
        grew: grewBy.get(name) ?? 0,
        detached,
        path,
      });
      return;
    }
  };
  const appLevel = (name: string) =>
    isAppGroup(name) &&
    (!name.startsWith("(") ||
      ["(closure)", "(array)", "(string)"].includes(name));
  for (const [name, nodes] of detachedSample) {
    if (retainers.length >= wanted) break;
    tryGroup(name, nodes, true);
  }
  // A named constructor says more than a Blink backing store, and either
  // more than an anonymous (string) / (array) row.
  const rank = (name: string) =>
    name.startsWith("(") ? 2 : name.startsWith("blink::") ? 1 : 0;
  const candidates = survivors
    .filter((g) => (grewBy.get(g.name) ?? 0) > 0)
    .sort(
      (a, b) =>
        rank(a.name) - rank(b.name) ||
        (grewBy.get(b.name) ?? 0) - (grewBy.get(a.name) ?? 0),
    );
  for (const g of [...candidates, ...survivors]) {
    if (retainers.length >= wanted) break;
    if (tried.has(g.name) || !appLevel(g.name)) continue;
    tryGroup(g.name, sample.get(g.name) ?? [], false);
  }

  const per = (a: number, b: number) => (b - a) / iterations;
  const bytesPer = per(mid.appBytes, end.appBytes);
  const detachedPer = per(mid.detachedNodes, end.detachedNodes);
  const listenersPer = per(
    mid.counters.jsEventListeners,
    end.counters.jsEventListeners,
  );
  const checks = [
    {
      name: "app heap growth per iteration (run 2)",
      ok: bytesPer <= thresholds.maxBytesPerIteration,
      detail: `${kb(bytesPer)}/iter (max ${kb(thresholds.maxBytesPerIteration)})`,
    },
    {
      name: "detached DOM nodes per iteration (run 2)",
      ok: detachedPer <= thresholds.maxDetachedPerIteration,
      detail: `${fmt(detachedPer)}/iter (max ${thresholds.maxDetachedPerIteration})`,
    },
    {
      name: "event listeners per iteration (run 2)",
      ok: listenersPer <= thresholds.maxListenersPerIteration,
      detail: `${fmt(listenersPer)}/iter (max ${thresholds.maxListenersPerIteration})`,
    },
  ];

  return {
    iterations,
    warmup: record.warmup,
    thresholds,
    phases,
    growth,
    detachedGrowth: diffGroups(midSummary.detached, graph.summary.detached),
    survivors,
    retainers,
    verdict: { ok: checks.every((c) => c.ok), checks },
    top: opts.top ?? 15,
  };
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
function kb(bytes: number): string {
  const sign = bytes < 0 ? "-" : "";
  const abs = Math.abs(bytes);
  if (abs >= 1024 * 1024) return `${sign}${(abs / 1024 / 1024).toFixed(1)} MB`;
  return `${sign}${(abs / 1024).toFixed(1)} KB`;
}
const signed = (n: number, f: (n: number) => string = fmt) =>
  `${n > 0 ? "+" : ""}${f(n)}`;

/** The report as concise text: phases, what grew, survivors, retainer paths, verdict. */
export function leakReportText(r: LeakReport): string {
  const [b, m, e] = r.phases;
  const row = (label: string, f: (p: LeakPhase) => number, show = fmt) =>
    `  ${label.padEnd(18)} ${[b, m, e].map((p) => show(f(p)).padStart(10)).join(" →")}   run 2: ${signed(f(e) - f(m), show)}`;
  const lines = [
    `leak test: warm-up ${r.warmup}, then 2 × ${r.iterations} iterations (post-GC)`,
    `  ${"".padEnd(18)} ${["base", "mid", "end"].map((s) => s.padStart(10)).join("  ")}`,
    row("heap", (p) => p.heapBytes, kb),
    row("app heap", (p) => p.appBytes, kb),
    row("heap objects", (p) => p.heapNodes),
    row("DOM nodes", (p) => p.counters.nodes),
    row("detached DOM", (p) => p.detachedNodes),
    row("event listeners", (p) => p.counters.jsEventListeners),
    row("documents", (p) => p.counters.documents),
    "",
    `grew over run 2 (MID → END), by constructor — count, size, run-1 survivors`,
    `(a group that grows but keeps none of run 1's objects is churn, not a leak):`,
  ];
  const survived = new Map(r.survivors.map((g) => [g.name, g.count]));
  const grew = r.growth
    .filter((g) => g.size > 0 || g.count > 0)
    .slice(0, r.top);
  if (grew.length === 0) lines.push("  (nothing)");
  for (const g of grew)
    lines.push(
      `  ${signed(g.count).padStart(8)}  ${signed(g.size, kb).padStart(10)}  ${String(survived.get(g.name) ?? 0).padStart(6)}  ${g.name}`,
    );
  const detached = r.detachedGrowth.filter((g) => g.count > 0);
  if (detached.length > 0) {
    lines.push("", "detached DOM grew over run 2:");
    for (const g of detached.slice(0, r.top))
      lines.push(`  ${signed(g.count).padStart(8)}  ${g.name}`);
  }
  lines.push(
    "",
    `survivors (allocated in run 1, still alive at END) — count, size:`,
  );
  if (r.survivors.length === 0) lines.push("  (none)");
  for (const g of r.survivors.slice(0, r.top))
    lines.push(
      `  ${String(g.count).padStart(8)}  ${kb(g.size).padStart(10)}  ${g.name}`,
    );
  if (r.retainers.length > 0) {
    lines.push("", "retainer paths (GC root first; one sample per group):");
    for (const s of r.retainers) {
      lines.push(
        `  ${s.detached ? "detached " : ""}${s.group} (${s.count} survivor(s), ${signed(s.grew)} over run 2):`,
      );
      const path =
        s.path.length > 14
          ? [...s.path.slice(0, 2), "…", ...s.path.slice(-11)]
          : s.path;
      for (const step of path) lines.push(`      ${step}`);
    }
  }
  lines.push("", `verdict: ${r.verdict.ok ? "PASS" : "FAIL"}`);
  for (const c of r.verdict.checks)
    lines.push(`  ${c.ok ? "ok  " : "FAIL"}  ${c.name}: ${c.detail}`);
  lines.push("", "snapshots (open in DevTools → Memory → Load):");
  for (const p of r.phases) lines.push(`  ${p.file}`);
  return lines.join("\n");
}
