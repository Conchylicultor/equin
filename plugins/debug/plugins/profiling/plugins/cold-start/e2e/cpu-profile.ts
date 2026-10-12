// --cpu-profile: where the page's main thread spends each window of a cold
// load, from a Chromium trace with V8's sampling profiler on. Each sample's
// self time is attributed to the code file it was running — a plugin artifact
// (`/artifacts/<plugin>.web.<hash>/…`), a vendor package
// (`/artifacts/set.<hash>/<pkg>.js`), the registry — or to V8's own buckets
// ((garbage collector), (program) = native/browser work, (idle)).
//
// The trace clock and the page clock differ; one boot User Timing mark, present
// in both, aligns them.

/** A window on the page clock (ms after navigation start). */
export interface CpuWindow {
  name: string;
  startMs: number;
  endMs: number;
}

/** Per window: totals and ranked self time, ready for the browser-track tables. */
export interface CpuProfileSummary {
  metrics: Record<string, number>;
  lists: Record<string, { name: string; value: number }[]>;
}

interface TraceEvent {
  name: string;
  cat?: string;
  ph: string;
  pid: number;
  tid: number;
  ts: number;
  id?: string;
  args?: { data?: Record<string, unknown> };
}

interface CallFrame {
  functionName?: string;
  url?: string;
  lineNumber?: number;
  columnNumber?: number;
}

interface ProfileNode {
  id: number;
  callFrame: CallFrame;
  parent?: number;
}

/** The bucket a code URL's self time is charged to. */
export function codeBucket(frame: CallFrame): string {
  // A trace's frames omit empty fields.
  const url = frame.url ?? "";
  const functionName = frame.functionName ?? "";
  if (url === "") {
    // V8's pseudo-frames keep their names; anything else without a URL is
    // native code (builtins, the browser's own bindings).
    return functionName.startsWith("(") ? functionName : "(native)";
  }
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch (err) {
    if (err instanceof TypeError) return url;
    throw err;
  }
  const m = /^\/artifacts\/([^/]+)\/(.+)$/.exec(path);
  if (!m) return path;
  const [, dir = "", file = ""] = m;
  if (dir.startsWith("set.")) {
    // A shared esbuild chunk names no package; keep its file so two chunks
    // stay apart.
    return `npm:${file.replace(/\.js$/, "")}`;
  }
  // `<dotted.plugin.path>.<folder>.<hash>` → `<dotted.plugin.path>`.
  return dir.replace(/\.[0-9a-f]{12,}$/, "").replace(/\.web$/, "");
}

/** The samples of one V8 profile: when each was taken and the node it hit. */
interface Samples {
  pid: number;
  tid: number;
  times: number[];
  nodeIds: number[];
  nodes: Map<number, ProfileNode>;
}

function collectProfiles(events: TraceEvent[]): Samples[] {
  const byId = new Map<string, Samples>();
  // A profile's `Profile` event carries its start; its chunks carry the
  // nodes seen so far and the samples' time deltas.
  const clock = new Map<string, number>();
  for (const e of events) {
    if (e.ph !== "P" || e.id === undefined) continue;
    const key = `${e.pid}:${e.id}`;
    if (e.name === "Profile") {
      const startTime = e.args?.data?.startTime;
      if (typeof startTime !== "number")
        throw new Error(`trace Profile event ${key} has no startTime`);
      clock.set(key, startTime);
      byId.set(key, {
        pid: e.pid,
        tid: e.tid,
        times: [],
        nodeIds: [],
        nodes: new Map(),
      });
      continue;
    }
    if (e.name !== "ProfileChunk") continue;
    const profile = byId.get(key);
    const at = clock.get(key);
    if (!profile || at === undefined)
      throw new Error(`trace ProfileChunk ${key} before its Profile event`);
    const data = e.args?.data as
      | {
          cpuProfile?: { nodes?: ProfileNode[]; samples?: number[] };
          timeDeltas?: number[];
        }
      | undefined;
    for (const n of data?.cpuProfile?.nodes ?? []) profile.nodes.set(n.id, n);
    const samples = data?.cpuProfile?.samples ?? [];
    const deltas = data?.timeDeltas ?? [];
    if (samples.length !== deltas.length)
      throw new Error(
        `trace ProfileChunk ${key}: ${samples.length} samples, ${deltas.length} deltas`,
      );
    let t = at;
    for (let i = 0; i < samples.length; i++) {
      t += deltas[i] ?? 0;
      profile.times.push(t);
      profile.nodeIds.push(samples[i] ?? 0);
    }
    clock.set(key, t);
  }
  return [...byId.values()];
}

/**
 * Summarise a trace over `windows`. `anchor` is a User Timing mark name and
 * its startTime on the page clock: it finds the page's main thread (the thread
 * that recorded it) and the offset between the two clocks.
 */
export function summariseCpuTrace(
  traceJson: string,
  anchor: { markName: string; pageMs: number },
  windows: CpuWindow[],
): CpuProfileSummary {
  const parsed = JSON.parse(traceJson) as
    { traceEvents: TraceEvent[] } | TraceEvent[];
  const events = Array.isArray(parsed) ? parsed : parsed.traceEvents;
  const mark = events.find(
    (e) => e.name === anchor.markName && (e.cat ?? "").includes("user_timing"),
  );
  if (!mark)
    throw new Error(
      `trace has no User Timing event ${anchor.markName} — was blink.user_timing recorded?`,
    );
  // µs on the trace clock ↔ ms on the page clock.
  const offsetUs = mark.ts - anchor.pageMs * 1000;
  const profiles = collectProfiles(events);
  const main = profiles.filter((p) => p.pid === mark.pid && p.tid === mark.tid);
  if (main.length === 0)
    throw new Error(
      `no V8 profile on the page's main thread (pid ${mark.pid} tid ${mark.tid}); profiles: ${profiles.map((p) => `${p.pid}/${p.tid}`).join(", ") || "none"}`,
    );

  // Per node, once: the deepest plugin frame on its stack (vendor code —
  // React's work loop, a query library — charged to the plugin code that
  // called into it), and every plugin on its stack.
  const isPlugin = (bucket: string) =>
    !bucket.startsWith("(") &&
    !bucket.startsWith("npm:") &&
    !bucket.startsWith("/");
  const stackOf = new Map<
    Samples,
    Map<number, { deepest: string; plugins: Set<string> }>
  >();
  const stack = (p: Samples, id: number) => {
    let memo = stackOf.get(p);
    if (!memo) stackOf.set(p, (memo = new Map()));
    const hit = memo.get(id);
    if (hit) return hit;
    let deepest: string | null = null;
    const plugins = new Set<string>();
    for (
      let n = p.nodes.get(id);
      n;
      n = n.parent === undefined ? undefined : p.nodes.get(n.parent)
    ) {
      const bucket = codeBucket(n.callFrame);
      if (!isPlugin(bucket)) continue;
      plugins.add(bucket);
      deepest ??= `${n.callFrame.functionName || "(anonymous)"} @ ${bucket}`;
    }
    const self = p.nodes.get(id);
    const out = {
      deepest:
        deepest ??
        `(no plugin frame) ${self ? codeBucket(self.callFrame) : "?"}`,
      plugins,
    };
    memo.set(id, out);
    return out;
  };

  const metrics: Record<string, number> = {};
  const lists: CpuProfileSummary["lists"] = {};
  for (const w of windows) {
    const lo = offsetUs + w.startMs * 1000;
    const hi = offsetUs + w.endMs * 1000;
    const byBucket = new Map<string, number>();
    const byFunction = new Map<string, number>();
    const byDeepest = new Map<string, number>();
    const byPluginOnStack = new Map<string, number>();
    let sampled = 0;
    for (const p of main) {
      for (let i = 0; i < p.times.length; i++) {
        const t = p.times[i] ?? 0;
        if (t < lo || t >= hi) continue;
        // A sample stands for the time until the next one.
        const next = p.times[i + 1] ?? t;
        const durMs = (Math.min(next, hi) - t) / 1000;
        const node = p.nodes.get(p.nodeIds[i] ?? -1);
        if (!node) continue;
        sampled += durMs;
        const bucket = codeBucket(node.callFrame);
        byBucket.set(bucket, (byBucket.get(bucket) ?? 0) + durMs);
        if (!bucket.startsWith("(")) {
          const fn = `${node.callFrame.functionName || "(anonymous)"} @ ${bucket}`;
          byFunction.set(fn, (byFunction.get(fn) ?? 0) + durMs);
        }
        if (bucket === "(idle)" || bucket === "(program)") continue;
        const st = stack(p, node.id);
        byDeepest.set(st.deepest, (byDeepest.get(st.deepest) ?? 0) + durMs);
        for (const plugin of st.plugins)
          byPluginOnStack.set(
            plugin,
            (byPluginOnStack.get(plugin) ?? 0) + durMs,
          );
      }
    }
    const idle = byBucket.get("(idle)") ?? 0;
    const gc = byBucket.get("(garbage collector)") ?? 0;
    const program = byBucket.get("(program)") ?? 0;
    metrics[`P ${w.name}: window ms`] = w.endMs - w.startMs;
    metrics[`P ${w.name}: busy ms (sampled − idle)`] = sampled - idle;
    metrics[`P ${w.name}: script ms (busy − GC − program)`] =
      sampled - idle - gc - program;
    metrics[`P ${w.name}: GC ms`] = gc;
    metrics[`P ${w.name}: (program) ms (native/browser)`] = program;
    const rank = (m: Map<string, number>) =>
      [...m]
        .filter(([name]) => name !== "(idle)")
        .map(([name, value]) => ({ name, value }))
        .sort((a, b) => b.value - a.value)
        .slice(0, 40);
    lists[`P ${w.name}: self ms by code file`] = rank(byBucket);
    lists[`P ${w.name}: self ms by function`] = rank(byFunction);
    lists[`P ${w.name}: ms under deepest plugin frame`] = rank(byDeepest);
    lists[`P ${w.name}: inclusive ms by plugin on stack`] =
      rank(byPluginOnStack);
  }
  return { metrics, lists };
}

/** The trace categories --cpu-profile records. */
export const CPU_TRACE_CATEGORIES = [
  "disabled-by-default-v8.cpu_profiler",
  "blink.user_timing",
  "__metadata",
];
