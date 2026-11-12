import {
  MACHINE_USAGE_TOP_PROCESSES,
  type OwnerSample,
} from "@plugins/debug/plugins/sentinel/plugins/machine-usage/core";
import {
  CLIMB_CURVE_BIN_MS,
  CLIMB_CURVE_MS,
  MAX_CLIMB_CURVE_POINTS,
  MAX_CLIMB_PAGE_TABS,
  MAX_CLIMB_PAGES,
  TAB_MEMORY_SAMPLE_EVERY_MS,
  type ClimbPage,
  type PageSeries,
  type TabMemoryClimb,
  type TabMemoryGrowth,
} from "../../core";
import { isChromeRenderer } from "./reduce";

const HOUR_MS = 60 * 60_000;
/**
 * A renderer's "now" is its lowest reading over this window: a GC sawtooth
 * (measured swings of 1+ GB within 20 minutes) reaches its trough inside it,
 * so a peak between collections never reads as the level.
 */
export const FLOOR_WINDOW_MS = 30 * 60_000;
/** How far back the floor's rise is measured from. */
export const CLIMB_LOOKBACK_MS = 3 * HOUR_MS;
/** A rise needs at least this much history behind it to be a rise. */
const MIN_CLIMB_SPAN_MS = HOUR_MS;
/** Readings the floor needs (the sampler takes one per 30 s). */
const MIN_FLOOR_POINTS = 3;
/** A page sampled this recently is still open. */
const ALIVE_MS = 3 * TAB_MEMORY_SAMPLE_EVERY_MS;
/** A page's figure explains the climb when it grew by this share of it. */
const EXPLAINS_SHARE = 1 / 3;
/** DOM growth worth naming: this many more nodes, and by this factor. */
const DOM_RISE_NODES = 10_000;
const DOM_RISE_FACTOR = 1.5;
/** A plainly large DOM, for a renderer that is high without climbing now. */
const DOM_HIGH_NODES = 50_000;

export interface ClimbThresholds {
  highFloorMb: number;
  climbFloorMb: number;
  climbRiseMb: number;
}

interface Reading {
  t: number;
  mb: number;
}

interface RendererReadings {
  /** Readings that named it. */
  named: Reading[];
  /**
   * Its floor readings: the named ones plus, for each later sample that did
   * not name it, an upper bound — the smallest process the sample's
   * by-memory half named (it was smaller than that). Without these, a
   * renderer named only at the top of each GC swing has a floor made of peaks.
   */
  floor: Reading[];
}

/** The by-memory half of a sample's top list comes first. */
const TOP_BY_MEM = MACHINE_USAGE_TOP_PROCESSES / 2;

/** Each Chrome renderer's readings, by pid, in time order. */
function readingsByPid(
  owners: readonly OwnerSample[],
): Map<number, RendererReadings> {
  const sorted = [...owners].sort((a, b) => a.sampledAt - b.sampledAt);
  const out = new Map<number, RendererReadings>();
  const namedIn = new Map<number, Set<number>>();
  for (const s of sorted)
    for (const p of s.top) {
      if (p.pid === undefined || !isChromeRenderer(p)) continue;
      let r = out.get(p.pid);
      if (!r) out.set(p.pid, (r = { named: [], floor: [] }));
      r.named.push({ t: s.sampledAt, mb: p.memMb });
      let seen = namedIn.get(p.pid);
      if (!seen) namedIn.set(p.pid, (seen = new Set()));
      seen.add(s.sampledAt);
    }
  for (const [pid, r] of out) {
    const seen = namedIn.get(pid)!;
    const firstT = r.named[0]!.t;
    for (const s of sorted) {
      if (seen.has(s.sampledAt)) {
        continue;
      }
      // Before it was first named it may not have existed: no bound.
      if (s.sampledAt < firstT) continue;
      const byMem = s.top.slice(0, TOP_BY_MEM);
      if (byMem.length < TOP_BY_MEM) continue;
      r.floor.push({
        t: s.sampledAt,
        mb: Math.min(...byMem.map((p) => p.memMb)),
      });
    }
    r.floor.push(...r.named);
    r.floor.sort((a, b) => a.t - b.t);
  }
  return out;
}

function lowest(readings: readonly Reading[]): Reading {
  return readings.reduce((m, r) => (r.mb < m.mb ? r : m));
}

/** Min / max per 20-minute bin over the last 6 h: the curve a reader sees. */
function curveOf(
  readings: readonly Reading[],
  now: number,
): TabMemoryClimb["curve"] {
  const bins = new Map<number, { minMb: number; maxMb: number }>();
  for (const r of readings) {
    if (r.t < now - CLIMB_CURVE_MS) continue;
    const t = Math.floor(r.t / CLIMB_CURVE_BIN_MS) * CLIMB_CURVE_BIN_MS;
    const bin = bins.get(t);
    if (bin) {
      bin.minMb = Math.min(bin.minMb, r.mb);
      bin.maxMb = Math.max(bin.maxMb, r.mb);
    } else bins.set(t, { minMb: r.mb, maxMb: r.mb });
  }
  return [...bins]
    .sort(([a], [b]) => a - b)
    .slice(-MAX_CLIMB_CURVE_POINTS)
    .map(([t, b]) => ({
      t,
      minMb: Math.round(b.minMb),
      maxMb: Math.round(b.maxMb),
    }));
}

const round = (v: number): number => Math.round(v);
const roundOrNull = (v: number | null): number | null =>
  v === null ? null : Math.round(v);

/** One page's figures across the window, or null when it sampled none in it. */
function pageIn(page: PageSeries, from: number, now: number): ClimbPage | null {
  // One sample period of slack before the window: a page that sampled just
  // before the baseline still has its starting figures read.
  const inWindow = page.points.filter(
    (p) => p.t >= from - TAB_MEMORY_SAMPLE_EVERY_MS && p.t <= now,
  );
  const first = inWindow[0];
  const last = inWindow.at(-1);
  if (first === undefined || last === undefined) return null;
  const heaps = inWindow.filter((p) => p.jsHeapUsedMb !== null);
  const latest = page.latest;
  return {
    pageId: page.pageId,
    worktree: page.worktree,
    host: latest.host,
    route: latest.route,
    focusedAppId: latest.focusedAppId,
    visible: latest.visible,
    alive: latest.sampledAt >= now - ALIVE_MS,
    pageStartedAt: latest.pageStartedAt,
    lastSampledAt: latest.sampledAt,
    jsHeapStartMb: roundOrNull(heaps[0]?.jsHeapUsedMb ?? null),
    jsHeapNowMb: roundOrNull(heaps.at(-1)?.jsHeapUsedMb ?? null),
    domStart: first.domNodes,
    domNow: last.domNodes,
    canvasImagesStartMb: round(first.canvasImagesMb),
    canvasImagesNowMb: round(last.canvasImagesMb),
    inAppTabsTotal: latest.inAppTabs.length,
    inAppTabs: latest.inAppTabs.slice(0, MAX_CLIMB_PAGE_TABS),
  };
}

const jsRise = (p: ClimbPage): number =>
  p.jsHeapStartMb === null || p.jsHeapNowMb === null
    ? 0
    : p.jsHeapNowMb - p.jsHeapStartMb;
const canvasRise = (p: ClimbPage): number =>
  p.canvasImagesNowMb - p.canvasImagesStartMb;
const domRise = (p: ClimbPage): number => p.domNow - p.domStart;

/**
 * What grew. Climbing: whose rise over the window explains a third of the
 * renderer's. High but not climbing now: which OPEN page's size does, of its
 * floor.
 */
export function classifyGrowth(
  pages: readonly ClimbPage[],
  riseMb: number | null,
  floorNowMb: number,
): TabMemoryGrowth {
  if (pages.length === 0) return "unattributed";
  // A renderer high now is held by what is open now: a closed page's size
  // says nothing about it. A climb is judged on growth, open or not.
  const judged = riseMb === null ? pages.filter((p) => p.alive) : pages;
  for (const growth of ["js-heap", "canvas-images", "dom"] as const)
    if (judged.some((p) => explains(p, growth, riseMb, floorNowMb)))
      return growth;
  return "native";
}

/**
 * Whether a page's figures are what `growth` names — the page behind the
 * classification, listed first.
 */
function explains(
  p: ClimbPage,
  growth: TabMemoryGrowth,
  riseMb: number | null,
  floorNowMb: number,
): boolean {
  const climbing = riseMb !== null;
  const ref = (climbing ? riseMb : floorNowMb) * EXPLAINS_SHARE;
  switch (growth) {
    case "js-heap":
      return (climbing ? jsRise(p) : (p.jsHeapNowMb ?? 0)) >= ref;
    case "canvas-images":
      return (climbing ? canvasRise(p) : p.canvasImagesNowMb) >= ref;
    case "dom":
      return climbing
        ? domRise(p) >= DOM_RISE_NODES &&
            p.domNow >= p.domStart * DOM_RISE_FACTOR
        : p.domNow >= DOM_HIGH_NODES;
    case "native":
    case "unattributed":
      return false;
  }
}

/**
 * The page(s) behind the classification first, then open pages, then the ones
 * whose figures grew the most.
 */
function rankPages(
  pages: ClimbPage[],
  explainer: (p: ClimbPage) => boolean,
): ClimbPage[] {
  const score = (p: ClimbPage) =>
    Math.max(0, jsRise(p)) + Math.max(0, canvasRise(p));
  return pages.sort(
    (a, b) =>
      Number(explainer(b)) - Number(explainer(a)) ||
      Number(b.alive) - Number(a.alive) ||
      score(b) - score(a) ||
      domRise(b) - domRise(a) ||
      b.lastSampledAt - a.lastSampledAt,
  );
}

/**
 * Every Chrome renderer of the user's Chrome whose memory is too large or
 * climbing, judged on its FLOOR (the lowest reading over the last 30 minutes)
 * so the GC sawtooth and a normal ~1.2 GB level never trip it:
 *
 * - `high`: the floor is at least `highFloorMb`;
 * - `climbing`: the floor is at least `climbFloorMb` AND at least
 *   `climbRiseMb` above the lowest reading of the 3 h before (with at least an
 *   hour of history behind it).
 *
 * Each comes with the pages that sampled themselves through its window (a
 * page cannot learn its renderer's pid: the join is by time), ranked, and
 * what grew as far as their own figures tell. The owner sampler names only
 * the largest processes: a sample that does not name a renderer bounds it by
 * the smallest process it named by memory, so the floor is never made of
 * peaks only.
 */
export function detectClimbs(
  owners: readonly OwnerSample[],
  pages: readonly PageSeries[],
  now: number,
  thresholds: ClimbThresholds,
): TabMemoryClimb[] {
  const out: TabMemoryClimb[] = [];
  for (const [pid, { named: readings, floor }] of readingsByPid(owners)) {
    const inFloorWindow = (r: Reading) =>
      r.t >= now - FLOOR_WINDOW_MS && r.t <= now;
    if (readings.filter(inFloorWindow).length < MIN_FLOOR_POINTS) continue;
    const recent = floor.filter(inFloorWindow);
    const floorNowMb = lowest(recent).mb;
    const before = floor.filter(
      (r) => r.t >= now - CLIMB_LOOKBACK_MS && r.t < now - FLOOR_WINDOW_MS,
    );
    const hasHistory =
      before.length > 0 && now - before[0]!.t >= MIN_CLIMB_SPAN_MS;
    const baseline = hasHistory ? lowest(before) : null;
    const riseMb = baseline === null ? null : floorNowMb - baseline.mb;
    const climbing =
      riseMb !== null &&
      floorNowMb >= thresholds.climbFloorMb &&
      riseMb >= thresholds.climbRiseMb;
    const high = floorNowMb >= thresholds.highFloorMb;
    if (!climbing && !high) continue;

    const windowStart = climbing ? baseline!.t : (before[0]?.t ?? recent[0]!.t);
    const judgedRise = climbing ? riseMb : null;
    // Classified over every page in the window, THEN cut: the page behind
    // the classification ranks first, so it is always listed.
    const all = pages
      .map((p) => pageIn(p, windowStart, now))
      .filter((p): p is ClimbPage => p !== null);
    const growth = classifyGrowth(all, judgedRise, floorNowMb);
    const candidates = rankPages(all, (p) =>
      explains(p, growth, judgedRise, floorNowMb),
    ).slice(0, MAX_CLIMB_PAGES);
    out.push({
      pid,
      trigger: climbing ? "climbing" : "high",
      floorNowMb: round(floorNowMb),
      peakMb: round(
        Math.max(
          ...readings
            .filter((r) => r.t >= now - CLIMB_CURVE_MS)
            .map((r) => r.mb),
        ),
      ),
      baselineMb: baseline === null ? null : round(baseline.mb),
      riseMb: roundOrNull(riseMb),
      riseMbPerHour:
        baseline === null || riseMb === null
          ? null
          : round((riseMb / (now - baseline.t)) * HOUR_MS),
      windowStart,
      windowEnd: now,
      growth,
      curve: curveOf(readings, now),
      pages: candidates,
      thresholds: { ...thresholds },
    });
  }
  return out.sort((a, b) => b.floorNowMb - a.floorNowMb);
}
