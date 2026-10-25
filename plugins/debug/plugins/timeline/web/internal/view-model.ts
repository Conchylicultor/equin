import type { SpanBar } from "@plugins/debug/plugins/profiling/web";
import {
  TIMELINE_SOURCES,
  type TimelineEvent,
  type TimelineSource,
} from "../../core";
import {
  HOST_LANE,
  type TimelineChunk,
  type TimelineHealthFrame,
  type TimelineHealthPoint,
} from "../../shared/frames";

// ---------------------------------------------------------------------------
// Pure view-model derivation for the Timeline tab: chunks → per-worktree lane
// groups of window-relative SpanBars. No React, no IO — co-located bun tests.
// ---------------------------------------------------------------------------

/** The wall-clock query window, frozen at reload time. */
export interface TimelineWindow {
  fromMs: number;
  toMs: number;
}

export const LOOKBACK_PRESETS = [
  { id: "15m", label: "15m", ms: 15 * 60_000 },
  { id: "1h", label: "1h", ms: 60 * 60_000 },
  { id: "6h", label: "6h", ms: 6 * 60 * 60_000 },
  { id: "24h", label: "24h", ms: 24 * 60 * 60_000 },
] as const;
export type LookbackId = (typeof LOOKBACK_PRESETS)[number]["id"];

// Fill answers "what is this?" (source identity, categorical tokens) and never
// changes with state — mirroring MultiSpanLane's fill=type convention — except
// that an elevated severity IS the information on this surface, so warning/
// error take over the fill with the semantic tokens.
const SOURCE_COLOR: Record<TimelineSource, string> = {
  trace: "bg-categorical-1",
  "slow-op": "bg-categorical-2",
  report: "bg-categorical-3",
  build: "bg-categorical-4",
  boot: "bg-categorical-5",
  // Duress episodes are always warning severity and render as cross-lane
  // bands, so the semantic token IS their identity color.
  duress: "bg-warning",
  // `health` never yields TimelineEvents (it rides the scan as health
  // frames); listed so the record stays exhaustive over TimelineSource.
  health: "bg-categorical-6",
};

export function sourceColorClass(source: TimelineSource): string {
  return SOURCE_COLOR[source];
}

export function barColorClass(
  ev: Pick<TimelineEvent, "severity" | "source">,
): string {
  if (ev.severity === "error") return "bg-destructive";
  if (ev.severity === "warning") return "bg-warning";
  return SOURCE_COLOR[ev.source];
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/**
 * One event → one window-relative SpanBar. Intervals straddling the window
 * edges are clipped; point events (startMs === endMs) rely on MultiSpanLane's
 * unconditional MIN_BAR_FRACTION floor to stay visible. In-flight builds pulse (fill=type,
 * treatment=state).
 */
export function eventToBar(
  ev: TimelineEvent,
  range: TimelineWindow,
  barId: string,
): SpanBar {
  const start = clamp(ev.startMs, range.fromMs, range.toMs);
  const end = clamp(ev.endMs, start, range.toMs);
  return {
    id: barId,
    startMs: start - range.fromMs,
    durationMs: end - start,
    colorClass: barColorClass(ev),
    treatment: ev.detail["inFlight"] === true ? "pulse" : "solid",
  };
}

export interface SourceLaneModel {
  source: TimelineSource;
  bars: SpanBar[];
  /** barId → source event, for the click → detail-strip lookup. */
  byBarId: Map<string, TimelineEvent>;
}

export interface WorktreeGroupModel {
  worktree: string;
  /** Sources with ≥1 event in the window, in TIMELINE_SOURCES order. */
  lanes: SourceLaneModel[];
  /** Failed (source, worktree) cells — rendered as compact error rows. */
  errors: { source: TimelineSource; error: string }[];
  eventCount: number;
}

/**
 * Buckets the scan's cells into per-worktree lane groups. `healthLanes`
 * (worktrees that only reported health series, no event chunks) still get a
 * group so their heat strip renders; the HOST_LANE is excluded — the host is
 * its own top group owned by the view. Groups sort by event count desc, then
 * name; lanes keep the closed TIMELINE_SOURCES order; bars sort by start.
 */
export function buildGroups(
  chunks: TimelineChunk[],
  healthLanes: string[],
  range: TimelineWindow,
): WorktreeGroupModel[] {
  const byWorktree = new Map<string, WorktreeGroupModel>();
  const ensure = (worktree: string): WorktreeGroupModel => {
    let group = byWorktree.get(worktree);
    if (!group) {
      group = { worktree, lanes: [], errors: [], eventCount: 0 };
      byWorktree.set(worktree, group);
    }
    return group;
  };

  for (const chunk of chunks) {
    if (!chunk.ok) {
      ensure(chunk.worktree).errors.push({
        source: chunk.source,
        error: chunk.error,
      });
      continue;
    }
    // Guard against events fully outside the window (the server already
    // filters; a pure re-clip keeps the mapping total either way). An all-empty
    // chunk creates no group — a worktree only appears when it has content.
    const events = chunk.events
      .filter((ev) => ev.endMs >= range.fromMs && ev.startMs <= range.toMs)
      .sort((a, b) => a.startMs - b.startMs);
    if (events.length === 0) continue;

    const group = ensure(chunk.worktree);
    let lane = group.lanes.find((l) => l.source === chunk.source);
    if (!lane) {
      lane = { source: chunk.source, bars: [], byBarId: new Map() };
      group.lanes.push(lane);
    }
    for (const ev of events) {
      // Index-based ids are collision-free by construction (source ids may
      // repeat across worktrees/forks).
      const barId = `${chunk.worktree}:${chunk.source}:${lane.bars.length}`;
      lane.bars.push(eventToBar(ev, range, barId));
      lane.byBarId.set(barId, ev);
      group.eventCount += 1;
    }
  }

  for (const laneName of healthLanes) {
    if (laneName !== HOST_LANE) ensure(laneName);
  }

  const sourceOrder = new Map(TIMELINE_SOURCES.map((s, i) => [s, i] as const));
  for (const group of byWorktree.values()) {
    group.lanes.sort(
      (a, b) =>
        (sourceOrder.get(a.source) ?? 0) - (sourceOrder.get(b.source) ?? 0),
    );
  }
  return [...byWorktree.values()].sort(
    (a, b) =>
      b.eventCount - a.eventCount || a.worktree.localeCompare(b.worktree),
  );
}

/** Merges health frames (one or more per lane) into per-lane sorted series. */
export function mergeHealth(
  frames: TimelineHealthFrame[],
): Map<string, TimelineHealthPoint[]> {
  const out = new Map<string, TimelineHealthPoint[]>();
  for (const frame of frames) {
    const existing = out.get(frame.worktree);
    if (existing) existing.push(...frame.samples);
    else out.set(frame.worktree, [...frame.samples]);
  }
  for (const samples of out.values()) samples.sort((a, b) => a.atMs - b.atMs);
  return out;
}

/** Flattens every lane's barId → event map into one lookup for the detail strip. */
export function collectBarEvents(
  groups: WorktreeGroupModel[],
): Map<string, TimelineEvent> {
  const out = new Map<string, TimelineEvent>();
  for (const group of groups) {
    for (const lane of group.lanes) {
      for (const [id, ev] of lane.byBarId) out.set(id, ev);
    }
  }
  return out;
}

/** All events across every ok chunk (the incident-grouping input). */
export function okEvents(chunks: TimelineChunk[]): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  for (const chunk of chunks) {
    if (chunk.ok) out.push(...chunk.events);
  }
  return out;
}
