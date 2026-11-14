// The reduction of JS Self-Profiling traces to a stall's stacks — PURE: no
// Profiler, no clock. stall-profiler.ts hands it the traces it kept and the
// stall's window; everything about what the report carries is decided (and
// tested, stack-profile.test.ts) here.

import type { StallStacks } from "../../core";
import { STALL } from "./constants";

/** The JS Self-Profiling API's trace (https://wicg.github.io/js-self-profiling/#the-profilertrace-dictionary). */
export interface ProfilerTrace {
  resources: string[];
  frames: {
    name: string;
    resourceId?: number;
    line?: number;
    column?: number;
  }[];
  stacks: { parentId?: number; frameId: number }[];
  /** `timestamp`: ms since the document's timeOrigin. No `stackId`: no JS ran. */
  samples: { timestamp: number; stackId?: number; marker?: string }[];
}

/** One stopped profiler run, on the wall clock (epoch ms). */
export interface KeptTrace {
  trace: ProfilerTrace;
  /** The document's `performance.timeOrigin`: sample timestamps are relative to it. */
  timeOrigin: number;
  /** When the profiler was started (epoch ms): no sample of it predates this. */
  startedAt: number;
  /** When it was stopped (epoch ms). */
  stoppedAt: number;
  /** Its buffer filled: sampling stopped at its last sample, not at its stop. */
  full: boolean;
}

export const STACKS = {
  /** Exact stacks kept, heaviest first. */
  TOP_STACKS: 5,
  /** Innermost frames kept per stack (the rest is the caller chain). */
  MAX_FRAMES: 25,
  /** Self-time frames kept. */
  TOP_SELF: 8,
  /**
   * A gap between two samples longer than this many intervals is not time
   * spent in the earlier one (the sampler was not running) — counted as one
   * interval.
   */
  GAP_INTERVALS: 4,
} as const;

const cap = (t: string): string =>
  t.length > STALL.STRING_CAP ? `${t.slice(0, STALL.STRING_CAP)}…` : t;

function frameLabel(trace: ProfilerTrace, frameId: number): string {
  const f = trace.frames[frameId];
  if (!f) return "(unknown frame)";
  const name = f.name || "(anonymous)";
  const url = f.resourceId === undefined ? null : trace.resources[f.resourceId];
  if (!url) return cap(name);
  return cap(`${name} (${url}:${f.line ?? "?"}:${f.column ?? "?"})`);
}

/** The frames of one stack, innermost first (`MAX_FRAMES` kept). */
function stackFrames(trace: ProfilerTrace, stackId: number): string[] {
  const frames: string[] = [];
  let id: number | undefined = stackId;
  // A malformed trace with a parent cycle would otherwise never end.
  for (let depth = 0; id !== undefined && depth < 10_000; depth++) {
    const s: ProfilerTrace["stacks"][number] | undefined = trace.stacks[id];
    if (!s) break;
    if (frames.length < STACKS.MAX_FRAMES)
      frames.push(frameLabel(trace, s.frameId));
    else {
      frames.push("…");
      break;
    }
    id = s.parentId;
  }
  return frames;
}

/**
 * The stacks that ran in `[startedAt, endedAt)` (epoch ms), aggregated across
 * the kept traces. `unavailable` when no trace covers the stall's start — a
 * window the profiler did not watch is not "no JS ran".
 */
export function reduceStallStacks(opts: {
  traces: readonly KeptTrace[];
  startedAt: number;
  endedAt: number;
  sampleIntervalMs: number;
}): StallStacks {
  const { startedAt, endedAt, sampleIntervalMs } = opts;
  // Rotation starts the next profiler before stopping the previous one, in
  // one task: each trace owns the instants from its start to the next one's
  // (or to its own stop).
  const ordered = [...opts.traces]
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((kept, i, all) => ({
      kept,
      until: Math.min(all[i + 1]?.startedAt ?? kept.stoppedAt, kept.stoppedAt),
    }));
  if (
    !ordered.some((o) => o.kept.startedAt <= startedAt && startedAt < o.until)
  )
    return {
      kind: "unavailable",
      reason:
        "no profile covers the stall's start (the profiler was not running then: the tab was hidden, or has been reloaded since)",
    };

  const byStack = new Map<
    string,
    { frames: string[]; ms: number; samples: number }
  >();
  const bySelf = new Map<string, number>();
  let sampledMs = 0;
  let noJsMs = 0;
  let truncated = false;
  let deltaSum = 0;
  let deltaCount = 0;
  const gap = sampleIntervalMs * STACKS.GAP_INTERVALS;

  for (const { kept, until } of ordered) {
    const samples = kept.trace.samples;
    const labels = new Map<number, string[]>();
    let lastAt = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i]!;
      const at = kept.timeOrigin + s.timestamp;
      lastAt = at;
      const next = samples[i + 1];
      const raw = next ? next.timestamp - s.timestamp : sampleIntervalMs;
      if (next && raw <= gap) {
        deltaSum += raw;
        deltaCount++;
      }
      if (at < startedAt || at >= endedAt || at >= until) continue;
      const dur = Math.min(raw > gap ? sampleIntervalMs : raw, endedAt - at);
      sampledMs += dur;
      if (s.stackId === undefined) {
        noJsMs += dur;
        continue;
      }
      let frames = labels.get(s.stackId);
      if (!frames) {
        frames = stackFrames(kept.trace, s.stackId);
        labels.set(s.stackId, frames);
      }
      const key = frames.join("\n");
      const agg = byStack.get(key) ?? { frames, ms: 0, samples: 0 };
      agg.ms += dur;
      agg.samples++;
      byStack.set(key, agg);
      const leaf = frames[0] ?? "(unknown frame)";
      bySelf.set(leaf, (bySelf.get(leaf) ?? 0) + dur);
    }
    // Its buffer filled while the stall was still running, and no later
    // trace took over before the stall ended: the tail went unsampled.
    if (
      kept.full &&
      lastAt < endedAt &&
      until > lastAt &&
      lastAt >= startedAt - gap
    )
      truncated = true;
  }

  const round = (ms: number): number => Math.round(ms);
  return {
    kind: "sampled",
    sampleIntervalMs:
      deltaCount > 0
        ? round((deltaSum / deltaCount) * 10) / 10
        : sampleIntervalMs,
    sampledMs: round(sampledMs),
    noJsMs: round(noJsMs),
    truncated,
    stacks: [...byStack.values()]
      .sort((a, b) => b.ms - a.ms)
      .slice(0, STACKS.TOP_STACKS)
      .map((s) => ({ ms: round(s.ms), samples: s.samples, frames: s.frames })),
    topSelf: [...bySelf.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, STACKS.TOP_SELF)
      .map(([frame, ms]) => ({ frame, ms: round(ms) })),
  };
}
