import { LAUNCH_SEGMENTS, type LaunchInstant } from "./phases";
import type { CheckoutSourceKind, CheckoutStep, LaunchMarks } from "./schemas";

/** What the stats read of one launch (a `LaunchRecord` is one). */
export interface LaunchSample {
  requestedAt: Date;
  marks: LaunchMarks;
  checkoutSteps: readonly CheckoutStep[];
  checkoutSource: CheckoutSourceKind | null;
}

export interface Percentiles {
  n: number;
  /** Null when no launch has the stretch. */
  p50: number | null;
  p90: number | null;
}

export interface SegmentStats extends Percentiles {
  id: string;
  label: string;
  total: boolean;
}

/** Nearest-rank percentile of `sorted` (ascending), `q` in (0, 1]. */
function nearestRank(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil(q * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!;
}

export function percentiles(values: readonly number[]): Percentiles {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: nearestRank(sorted, 0.5),
    p90: nearestRank(sorted, 0.9),
  };
}

/** The instant `at` of a launch, epoch ms; undefined when not reached. */
export function instantOf(
  launch: LaunchSample,
  at: LaunchInstant,
): number | undefined {
  return at === "requested" ? launch.requestedAt.getTime() : launch.marks[at];
}

/**
 * Each segment's duration (ms) over the launches that reached both its ends —
 * a launch still in flight, or one that skipped a phase (a scratch workspace
 * has no checkout), counts only in the segments it has.
 */
export function segmentStats(
  launches: readonly LaunchSample[],
): SegmentStats[] {
  return LAUNCH_SEGMENTS.map((seg) => {
    const values: number[] = [];
    for (const l of launches) {
      const from = instantOf(l, seg.from);
      const to = instantOf(l, seg.to);
      if (from !== undefined && to !== undefined) values.push(to - from);
    }
    return {
      id: seg.id,
      label: seg.label,
      total: seg.total === true,
      ...percentiles(values),
    };
  });
}

/**
 * Each checkout step's duration over the launches whose checkout ran it — a
 * step a checkout ran twice counts its sum.
 */
export function checkoutStepStats(
  launches: readonly LaunchSample[],
): (Percentiles & { step: string })[] {
  const byStep = new Map<string, number[]>();
  for (const l of launches) {
    const sums = new Map<string, number>();
    for (const s of l.checkoutSteps)
      sums.set(s.step, (sums.get(s.step) ?? 0) + s.ms);
    for (const [step, ms] of sums) {
      const list = byStep.get(step) ?? [];
      list.push(ms);
      byStep.set(step, list);
    }
  }
  return [...byStep].map(([step, values]) => ({
    step,
    ...percentiles(values),
  }));
}
