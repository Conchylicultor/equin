import type { TimelineEvent, TimelineSeverity } from "../../core";
import { HOST_LANE, type TimelineFrame, type TimelineHealthPoint } from "../../shared/frames";
import { hostPressureScore, pressureBucket } from "../../shared/pressure";
import { formatDurationMs, formatLocal, formatLocalFull, tzName } from "./format";

// Pure renderer for the get_timeline text report. Takes the collected frames
// (order-independent — reduced into structured buckets) and produces the
// agent-facing string. No I/O, no clock reads beyond the injected ms — fully
// bun:test-able (see render.test.ts).

export interface RenderOpts {
  fromMs: number;
  toMs: number;
  minSeverity: TimelineSeverity;
  maxEvents: number;
  // cpuCount is the load-ratio denominator for the host pressure score; the
  // tool passes os.cpus().length, tests pin it for determinism.
  cpuCount: number;
  // IANA zone override for deterministic tests; host zone when omitted.
  tz?: string;
}

// error > warning > info. Used for both the minSeverity gate and the
// severity-first retention that protects errors/warnings from being dropped
// for a flood of info.
const SEVERITY_RANK: Record<TimelineSeverity, number> = { info: 0, warning: 1, error: 2 };

// Backend event-loop p99 ramp, mirroring the web heat strip (heat.ts):
// <100 calm · <500 mild · <1000 strong · ≥1000 error. A lane whose peak p99 is
// at or above the mild line is "above warning" and gets its own line; calmer
// lanes collapse to a single omitted-count.
const BACKEND_P99_WARNING_MS = 100;

interface Buckets {
  total: number | undefined;
  duress: TimelineEvent[];
  events: TimelineEvent[]; // non-duress
  chunkErrors: { source: string; worktree: string; error: string }[];
  health: Map<string, TimelineHealthPoint[]>;
}

function reduceFrames(frames: readonly TimelineFrame[]): Buckets {
  const b: Buckets = {
    total: undefined,
    duress: [],
    events: [],
    chunkErrors: [],
    health: new Map(),
  };
  for (const f of frames) {
    if ("total" in f) {
      b.total = f.total;
    } else if ("chunk" in f) {
      if (f.chunk.ok) {
        for (const e of f.chunk.events) (e.source === "duress" ? b.duress : b.events).push(e);
      } else {
        b.chunkErrors.push({ source: f.chunk.source, worktree: f.chunk.worktree, error: f.chunk.error });
      }
    } else if ("health" in f) {
      b.health.set(f.health.worktree, f.health.samples);
    }
    // { end: true } carries no payload.
  }
  return b;
}

function sevTag(sev: TimelineSeverity): string {
  return { info: "INFO ", warning: "WARN ", error: "ERROR" }[sev];
}

// ---------------------------------------------------------------------------

function renderHeader(b: Buckets, opts: RenderOpts, lines: string[]): void {
  const from = formatLocalFull(opts.fromMs, opts.tz);
  const to = formatLocalFull(opts.toMs, opts.tz);
  lines.push(`TIMELINE  ${from} → ${to}  (${tzName(opts.tz)})`);
  const healthLanes = b.health.size;
  const scanned = b.total ?? b.chunkErrors.length + b.events.length; // total is emitted first; fall back defensively
  lines.push(
    `window ${formatDurationMs(opts.toMs - opts.fromMs)} · scanned ${scanned} chunks · ` +
      `${b.events.length} events · ${b.duress.length} duress · ` +
      `${healthLanes} health lanes · ${b.chunkErrors.length} chunk errors`,
  );
}

function renderDuress(b: Buckets, opts: RenderOpts, lines: string[]): void {
  lines.push("");
  lines.push("DURESS  (host-global — signal is thinned inside these)");
  if (b.duress.length === 0) {
    lines.push("  none in window");
    return;
  }
  // Never capped: a duress band means the window's other signal is deliberately
  // thinned, so the agent must always see every episode.
  for (const e of [...b.duress].sort((a, c) => a.startMs - c.startMs)) {
    const start = formatLocal(e.startMs, opts.tz);
    const inFlight = e.detail.inFlight === true;
    const endUnknown = e.detail.endUnknown === true;
    const end = inFlight
      ? "in-flight"
      : endUnknown
        ? `${formatLocal(e.endMs, opts.tz)} (end-unknown)`
        : `${formatLocal(e.endMs, opts.tz)} (${formatDurationMs(e.endMs - e.startMs)})`;
    const reason = typeof e.detail.reason === "string" ? e.detail.reason : e.label;
    lines.push(`  ${start} → ${end}  ${reason}`);
  }
}

function renderHostPressure(b: Buckets, opts: RenderOpts, lines: string[]): void {
  lines.push("");
  lines.push("HOST PRESSURE (peak)");
  const samples = b.health.get(HOST_LANE) ?? [];
  let peak: TimelineHealthPoint | undefined;
  let peakScore = -1;
  for (const s of samples) {
    if (s.wallJumpMs !== undefined) continue; // sleep-wake points describe the suspend, not load
    const score = hostPressureScore({ loadAvg1: s.loadAvg1, decompPerSec: s.decompPerSec }, opts.cpuCount);
    if (score > peakScore) {
      peakScore = score;
      peak = s;
    }
  }
  if (!peak) {
    lines.push("  no host health samples in window");
    return;
  }
  const bucket = pressureBucket(peakScore);
  const bits = [
    `score ${peakScore.toFixed(2)} [${bucket}]`,
    `@ ${formatLocal(peak.atMs, opts.tz)}`,
    `load ${(peak.loadAvg1 ?? 0).toFixed(2)}/${opts.cpuCount}cpu`,
  ];
  if (peak.decompPerSec !== undefined) bits.push(`decomp ${Math.round(peak.decompPerSec)}/s`);
  if (peak.swap !== undefined) bits.push(`swap ${Math.round(peak.swap)}/s`);
  lines.push(`  ${bits.join("  ")}`);
}

function renderBackendHealth(b: Buckets, opts: RenderOpts, lines: string[]): void {
  lines.push("");
  lines.push("BACKEND HEALTH (peak event-loop p99)");
  interface LanePeak {
    worktree: string;
    p99Ms: number;
    physMb: number | undefined;
    atMs: number;
  }
  const peaks: LanePeak[] = [];
  for (const [worktree, samples] of b.health) {
    if (worktree === HOST_LANE) continue;
    let peak: TimelineHealthPoint | undefined;
    for (const s of samples) {
      if (s.wallJumpMs !== undefined) continue;
      if (!peak || (s.p99Ms ?? 0) > (peak.p99Ms ?? 0)) peak = s;
    }
    if (peak) peaks.push({ worktree, p99Ms: peak.p99Ms ?? 0, physMb: peak.physMb, atMs: peak.atMs });
  }
  if (peaks.length === 0) {
    lines.push("  no backend health samples in window");
    return;
  }
  peaks.sort((a, c) => c.p99Ms - a.p99Ms);
  const above = peaks.filter((p) => p.p99Ms >= BACKEND_P99_WARNING_MS);
  for (const p of above) {
    const phys = p.physMb !== undefined ? `  phys ${Math.round(p.physMb)}MB` : "";
    lines.push(`  ${p.worktree}  peak p99 ${Math.round(p.p99Ms)}ms @ ${formatLocal(p.atMs, opts.tz)}${phys}`);
  }
  const omitted = peaks.length - above.length;
  if (omitted > 0) lines.push(`  … ${omitted} lanes below warning omitted`);
}

function renderEvents(b: Buckets, opts: RenderOpts, lines: string[]): void {
  lines.push("");
  lines.push("EVENTS");
  const min = SEVERITY_RANK[opts.minSeverity];
  const eligible = b.events.filter((e) => SEVERITY_RANK[e.severity] >= min);

  // Severity-first retention: order by severity class (error > warning > info),
  // then recency within class, keep up to maxEvents. Errors/warnings can never
  // be dropped to make room for a flood of info.
  const byPriority = [...eligible].sort(
    (a, c) => SEVERITY_RANK[c.severity] - SEVERITY_RANK[a.severity] || c.endMs - a.endMs,
  );
  const kept = byPriority.slice(0, opts.maxEvents);

  // Re-sort the KEPT set by wall clock so cross-worktree cause→effect reads
  // top-to-bottom in time, not by severity.
  const rendered = [...kept].sort((a, c) => a.startMs - c.startMs || a.endMs - c.endMs);
  if (rendered.length === 0) {
    lines.push("  none in window at this severity");
  } else {
    for (const e of rendered) {
      const trace = e.traceId ? `  trace=${e.traceId}` : "";
      lines.push(
        `  ${formatLocal(e.startMs, opts.tz)} [${sevTag(e.severity)}] ${e.source}  ${e.worktree}  ${e.label}${trace}`,
      );
    }
  }

  // Explicit drop accounting — NO SILENT CAPS. Everything eligible-but-capped
  // AND everything below minSeverity is counted, grouped by source+severity.
  const keptSet = new Set(kept);
  const dropped = [...b.events.filter((e) => SEVERITY_RANK[e.severity] < min), ...eligible.filter((e) => !keptSet.has(e))];
  if (dropped.length > 0) {
    const groups = new Map<string, number>();
    for (const e of dropped) {
      const key = `${e.source} ${e.severity}`;
      groups.set(key, (groups.get(key) ?? 0) + 1);
    }
    const parts = [...groups.entries()]
      .sort((a, c) => c[1] - a[1] || (a[0] < c[0] ? -1 : 1))
      .map(([key, n]) => {
        const [source, severity] = key.split(" ");
        return `${source} ${n} ${severity}`;
      });
    lines.push(`  dropped (raise minSeverity / narrow window): ${parts.join(", ")}`);
  }
}

function renderChunkErrors(b: Buckets, lines: string[]): void {
  lines.push("");
  lines.push("CHUNK ERRORS (data missing here)");
  if (b.chunkErrors.length === 0) {
    lines.push("  none");
    return;
  }
  // Group per (worktree, error): openSession failing emits every source of a
  // worktree as its own error cell with the same message — collapse them into
  // one line listing the affected sources.
  const groups = new Map<string, { worktree: string; error: string; sources: string[] }>();
  for (const c of b.chunkErrors) {
    const key = `${c.worktree} ${c.error}`;
    const g = groups.get(key);
    if (g) g.sources.push(c.source);
    else groups.set(key, { worktree: c.worktree, error: c.error, sources: [c.source] });
  }
  for (const g of groups.values()) {
    lines.push(`  ${g.worktree}  ${g.sources.join(", ")}: ${g.error}`);
  }
}

/** Render the collected timeline frames as the agent-facing local-time report. */
export function renderTimeline(frames: readonly TimelineFrame[], opts: RenderOpts): string {
  const b = reduceFrames(frames);
  const lines: string[] = [];
  renderHeader(b, opts, lines);
  renderDuress(b, opts, lines);
  renderHostPressure(b, opts, lines);
  renderBackendHealth(b, opts, lines);
  renderEvents(b, opts, lines);
  renderChunkErrors(b, lines);
  return lines.join("\n");
}
