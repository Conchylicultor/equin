// The browser track of one cold-start iteration, broken down from Resource
// Timing, the main thread's long tasks and the boot trace:
//   A. before DOMContentLoaded — what the document pulls in, and network vs
//      main-thread time;
//   B. during the eager `load-plugins` span — plugin imports, the artifacts
//      they fetched, fetch vs main-thread time, the slowest and largest plugins;
//   C. which tier each imported plugin came from, against the two end instants.

/** One Resource Timing entry, on the page clock (ms after navigation start). */
export interface ResourceRow {
  name: string;
  initiatorType: string;
  startMs: number;
  responseEndMs: number;
  transferSize: number;
  decodedBodySize: number;
}

/** One plugin import timed by boot-trace's `traceBootPluginLoad`. */
export interface PluginLoadRow {
  pluginPath: string;
  tier: "eager" | "priority" | "deferred";
  ok: boolean;
  startMs: number;
  endMs: number;
}

export interface BrowserTrackInput {
  documentTransfer: number;
  documentDecoded: number;
  importMapBytes: number;
  domContentLoadedMs: number | null;
  resources: ResourceRow[];
  longTasks: { startMs: number; durationMs: number }[];
  pluginLoads: PluginLoadRow[];
  loadPlugins: { startMs: number; endMs: number } | null;
  firstDataMs: number | null;
  routeContentMs: number | null;
  deferredCompleteMs: number | null;
  /**
   * The renderer's cumulative main-thread time (CDP Performance.getMetrics),
   * sampled right after route content was seen — the time the long-task API
   * misses when module evaluation runs as many sub-50 ms tasks.
   */
  mainThread: {
    sampledAtMs: number;
    taskMs: number;
    scriptMs: number;
    layoutMs: number;
    styleMs: number;
  } | null;
}

/** Scalar metrics (aggregated as medians across iterations) and ranked lists (aggregated by name). */
export interface BrowserTrack {
  metrics: Record<string, number>;
  lists: Record<string, { name: string; value: number }[]>;
}

export type ResourceKind =
  | "entry JS"
  | "plugin artifact"
  | "vendor JS"
  | "CSS"
  | "font"
  | "sprite"
  | "api"
  | "other";

export function resourceKind(name: string): ResourceKind {
  const path = new URL(name).pathname;
  if (path.startsWith("/api/")) return "api";
  if (/\.css$/.test(path)) return "CSS";
  if (/\.(woff2?|ttf|otf)$/.test(path)) return "font";
  if (/sprite|\.svg$/.test(path)) return "sprite";
  const artifact = /^\/artifacts\/([^/]+)\//.exec(path)?.[1];
  if (artifact === undefined) return "other";
  if (artifact.startsWith("set.")) return "vendor JS";
  if (artifact.startsWith("web-core.entry.")) return "entry JS";
  return "plugin artifact";
}

/**
 * The plugin an artifact URL belongs to: `/artifacts/<dotted plugin path>.<runtime>.<hash>/…`
 * names it (all of one plugin's runtimes add up); a vendor set names the file.
 */
export function artifactOwner(name: string): string {
  const path = new URL(name).pathname;
  const dir = /^\/artifacts\/([^/]+)\//.exec(path)?.[1];
  if (dir === undefined) return path;
  if (dir.startsWith("set.")) return `vendor ${path.split("/").pop()}`;
  const parts = dir.split(".");
  return parts.slice(0, -2).join(".");
}

/** Total length of the union of [start, end) intervals, clipped to [from, to). */
function unionMs(
  intervals: { start: number; end: number }[],
  from: number,
  to: number,
): number {
  const clipped = intervals
    .map((i) => ({ start: Math.max(i.start, from), end: Math.min(i.end, to) }))
    .filter((i) => i.end > i.start)
    .sort((a, b) => a.start - b.start);
  let total = 0;
  let curStart = -Infinity;
  let curEnd = -Infinity;
  for (const i of clipped) {
    if (i.start > curEnd) {
      if (curEnd > curStart) total += curEnd - curStart;
      curStart = i.start;
      curEnd = i.end;
    } else curEnd = Math.max(curEnd, i.end);
  }
  if (curEnd > curStart) total += curEnd - curStart;
  return total;
}

function longTaskMs(
  input: BrowserTrackInput,
  from: number,
  to: number,
): { ms: number; count: number } {
  let ms = 0;
  let count = 0;
  for (const t of input.longTasks) {
    const overlap =
      Math.min(t.startMs + t.durationMs, to) - Math.max(t.startMs, from);
    if (overlap <= 0) continue;
    ms += overlap;
    count++;
  }
  return { ms, count };
}

const KB = 1024;

export function browserTrack(input: BrowserTrackInput): BrowserTrack {
  const metrics: Record<string, number> = {};
  const lists: BrowserTrack["lists"] = {};
  const fetchSpan = (r: ResourceRow) => ({
    start: r.startMs,
    end: r.responseEndMs,
  });

  // A. Before DOMContentLoaded.
  const dcl = input.domContentLoadedMs;
  if (dcl !== null) {
    const before = input.resources.filter((r) => r.startMs < dcl);
    metrics["A requests (incl. document)"] = before.length + 1;
    metrics["A document transfer KB"] = input.documentTransfer / KB;
    metrics["A document decoded KB"] = input.documentDecoded / KB;
    metrics["A   of which inline import map KB"] = input.importMapBytes / KB;
    const kinds = new Map<ResourceKind, ResourceRow[]>();
    for (const r of before) {
      const k = resourceKind(r.name);
      kinds.set(k, [...(kinds.get(k) ?? []), r]);
    }
    for (const [k, rows] of kinds) {
      metrics[`A ${k} requests`] = rows.length;
      metrics[`A ${k} transfer KB`] =
        rows.reduce((s, r) => s + r.transferSize, 0) / KB;
      metrics[`A ${k} decoded KB`] =
        rows.reduce((s, r) => s + r.decodedBodySize, 0) / KB;
    }
    metrics["A total transfer KB"] =
      (input.documentTransfer +
        before.reduce((s, r) => s + r.transferSize, 0)) /
      KB;
    metrics["A total decoded KB"] =
      (input.documentDecoded +
        before.reduce((s, r) => s + r.decodedBodySize, 0)) /
      KB;
    metrics["A network busy ms (union of fetches)"] = unionMs(
      before.map(fetchSpan),
      0,
      dcl,
    );
    metrics["A last fetch before DCL ends at ms"] = Math.max(
      0,
      ...before.map((r) => r.responseEndMs),
    );
    const lt = longTaskMs(input, 0, dcl);
    metrics["A main-thread long tasks ms"] = lt.ms;
    metrics["A main-thread long tasks count"] = lt.count;
    lists["A largest files before DCL (decoded KB)"] = [...before]
      .sort((a, b) => b.decodedBodySize - a.decodedBodySize)
      .slice(0, 10)
      .map((r) => ({
        name: new URL(r.name).pathname,
        value: r.decodedBodySize / KB,
      }));
  }

  // B. During the eager load-plugins span.
  const lp = input.loadPlugins;
  if (lp !== null) {
    const eager = input.pluginLoads.filter((p) => p.tier === "eager");
    metrics["B load-plugins span ms"] = lp.endMs - lp.startMs;
    metrics["B eager plugin modules imported"] = eager.length;
    metrics["B eager plugin imports failed"] = eager.filter(
      (p) => !p.ok,
    ).length;
    const js = input.resources.filter((r) => {
      const k = resourceKind(r.name);
      return k === "plugin artifact" || k === "vendor JS" || k === "entry JS";
    });
    // Everything the eager tier had in hand by the end of the span, split by
    // whether it was already fetched (modulepreload) or fetched during it.
    const inHand = js.filter((r) => r.responseEndMs <= lp.endMs);
    const prefetched = inHand.filter((r) => r.responseEndMs <= lp.startMs);
    const during = js.filter(
      (r) => r.startMs < lp.endMs && r.responseEndMs > lp.startMs,
    );
    metrics["B JS artifacts in hand by span end"] = inHand.length;
    metrics["B   fetched before the span (preloaded)"] = prefetched.length;
    metrics["B   fetched during the span"] = during.length;
    metrics["B   fetched during: transfer KB"] =
      during.reduce((s, r) => s + r.transferSize, 0) / KB;
    metrics["B   fetched during: decoded KB"] =
      during.reduce((s, r) => s + r.decodedBodySize, 0) / KB;
    metrics["B JS decoded KB in hand by span end"] =
      inHand.reduce((s, r) => s + r.decodedBodySize, 0) / KB;
    metrics["B network busy ms in span (union of fetches)"] = unionMs(
      input.resources.map(fetchSpan),
      lp.startMs,
      lp.endMs,
    );
    const lt = longTaskMs(input, lp.startMs, lp.endMs);
    metrics["B main-thread long tasks ms in span"] = lt.ms;
    metrics["B main-thread long tasks count in span"] = lt.count;
    lists["B slowest eager plugin imports (resolved after ms)"] = [...eager]
      .sort((a, b) => b.endMs - b.startMs - (a.endMs - a.startMs))
      .slice(0, 15)
      .map((p) => ({ name: p.pluginPath, value: p.endMs - p.startMs }));
    const bytes = new Map<string, number>();
    for (const r of inHand)
      bytes.set(
        artifactOwner(r.name),
        (bytes.get(artifactOwner(r.name)) ?? 0) + r.decodedBodySize,
      );
    lists["B largest plugins/vendors in hand by span end (decoded KB)"] = [
      ...bytes,
    ]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([name, value]) => ({ name, value: value / KB }));
  }

  // M. Main-thread time from the navigation to route content, all tasks.
  const mt = input.mainThread;
  if (mt !== null) {
    metrics["M main thread sampled at ms"] = mt.sampledAtMs;
    metrics["M   task time ms (all tasks)"] = mt.taskMs;
    metrics["M   script time ms"] = mt.scriptMs;
    metrics["M   layout + style ms"] = mt.layoutMs + mt.styleMs;
    metrics["M   idle ms (sample point − task time)"] =
      mt.sampledAtMs - mt.taskMs;
  }

  // C. Plugins imported, by tier, against the end instants.
  const by = (tier: PluginLoadRow["tier"]) =>
    input.pluginLoads.filter((p) => p.tier === tier);
  const endedBy = (rows: PluginLoadRow[], at: number | null) =>
    at === null ? NaN : rows.filter((p) => p.endMs <= at).length;
  metrics["C eager plugins imported"] = by("eager").length;
  metrics["C   resolved before first data"] = endedBy(
    by("eager"),
    input.firstDataMs,
  );
  metrics["C priority (active app) plugins imported"] = by("priority").length;
  metrics["C   resolved before route content"] = endedBy(
    by("priority"),
    input.routeContentMs,
  );
  metrics["C deferred (rest) plugins imported"] = by("deferred").length;
  metrics["C   of which after route content"] =
    input.routeContentMs === null
      ? NaN
      : by("deferred").filter((p) => p.endMs > (input.routeContentMs ?? 0))
          .length;
  metrics["C deferred tier complete at ms"] = input.deferredCompleteMs ?? NaN;
  return { metrics, lists };
}
