import { z } from "zod";
import { PER_UNIT_BYTES } from "./budget";

// What a `cpu` share is charged for memory, per holder, from what holders of
// its kind of work have been MEASURED to use.
//
// A held slot used to reserve a whole `PER_UNIT_BYTES` quantum — the heavy
// type-check worker's footprint per unit — until the fleet's measured use
// exceeded the total. Right for that worker, but most units are spent on far
// lighter work (artifact threads, test files, a check holding slots between
// its heavy children): on 2026-11-13 ops used p50 1.0 GB per held slot, and
// in 24 of 81 readings reservations, not use, closed the window ("6 slots
// held, 2.0 GB measured, ops charged 21.6 GB").
//
// So a holder names its work when it acquires (`HolderWork`, required by
// `withHostGrant`), main's owner sampler records how much each holder's
// process tree peaked at (the holder-peak ledger), and a share is reserved
// what holders of its work were measured to peak at — the charge is derived
// from the record, never a guessed number, and moves with it.

/**
 * The kinds of work that hold `cpu` shares. Every acquirer names one, and the
 * share is reserved what that work has been measured to peak at. A closed
 * set: a new kind of holder adds its id here (and its reservation starts at
 * the whole quantum per unit until it has a record).
 */
export const HOLDER_WORK = [
  /** `./equin build`: its whole run, nested check included. */
  "build",
  /** A top-level `./equin check`. */
  "check",
  /** A top-level `./equin test`. */
  "test",
  /** `./equin push`'s critical section (rebase, install, normalize, checks). */
  "push",
  /** A supervised job body or a CLI exec context (`admitBackground`): one unit. */
  "job",
  /** The type-check backstop's dual-mode worker run (2 units). */
  "type-check-backstop",
] as const;
export type HolderWork = (typeof HOLDER_WORK)[number];

/**
 * A live holder's marker (`locks/cpu-holders/<pid>-<n>.json`), written by
 * `withHostGrant` once its share is held and flocked for the share's life —
 * the lock is the liveness, as for the op markers.
 */
export const CpuHolderMarkerSchema = z.object({
  v: z.literal(1),
  /** The holding process: its process tree is what the holder is measured on. */
  pid: z.number().int().positive(),
  work: z.enum(HOLDER_WORK),
  /** `cpu` slots this share holds. */
  units: z.number().int().positive(),
  lane: z.enum(["interactive", "background"]),
  /** When the share was taken (epoch ms). */
  since: z.number(),
});
export type CpuHolderMarker = z.infer<typeof CpuHolderMarkerSchema>;

/** Whether a reservation comes from the record or is the per-unit quantum. */
export type ReserveBasis = "measured" | "unmeasured";

/**
 * One live holder, as the fleet reading carries it. `work` and `reserveBasis`
 * are plain strings here, not the enums: every CLI on the box reads main's
 * reading, and one older than main must still read a work it does not know —
 * the charge needs only the numbers.
 */
export const HolderReadingSchema = z.object({
  work: z.string(),
  units: z.number().int().positive(),
  /** Physical footprint of the holder's process tree at the reading. */
  bytes: z.number().nonnegative(),
  /** What the share is reserved: `holderReserve` of its work's record. */
  reserveBytes: z.number().nonnegative(),
  reserveBasis: z.string(),
});
export type HolderReading = z.infer<typeof HolderReadingSchema>;

/**
 * One finished holder, appended to the holder-peak ledger by main's owner
 * sampler when the holder's marker goes: the largest footprint its process
 * tree was read at (every 30 s), its units and how long it held them.
 */
export const HolderPeakRecordSchema = z.object({
  /** When the holder was last seen (ISO). */
  t: z.string(),
  work: z.enum(HOLDER_WORK),
  units: z.number().int().positive(),
  lane: z.enum(["interactive", "background"]),
  /**
   * The holder tree's peak: the largest, across the sampler's readings of it,
   * of the sum of its live processes' LIFETIME peak footprints (the kernel's
   * `ri_lifetime_max_phys_footprint`) — so a spike between two readings is
   * kept, and an upper bound, since those peaks need not have coincided.
   */
  peakBytes: z.number().nonnegative(),
  /** How many readings saw it. */
  samples: z.number().int().positive(),
  /** First to last reading (ms): 0 for a holder seen once. */
  seenMs: z.number().nonnegative(),
});
export type HolderPeakRecord = z.infer<typeof HolderPeakRecordSchema>;

/** How far back a holder's peak still describes today's work. */
export const HOLDER_PEAK_WINDOW_MS = 14 * 24 * 3600 * 1000;

/**
 * Fewer recorded holders of a work than this cannot stand for it. Ten
 * because, with the nearest-rank quantile below, a work with 10–19 records
 * is reserved the LARGEST peak it has recorded (rank ⌈0.95·n⌉ = n): the
 * quantile only starts discounting the top peak at 20, once one outlier is
 * one holder in twenty. Under ten, no record is trusted at all.
 */
export const MIN_HOLDER_PEAKS = 10;

/**
 * How many of a work's most recent holders its reservation is never below:
 * a work that changes shape (a new heavy check, a bigger build) lifts its
 * reservation from the first holders that show it, instead of waiting for
 * them to be 5 % of two weeks of records.
 */
export const RECENT_HOLDER_PEAKS = 5;

/**
 * Which of a work's recorded peaks a share is reserved. A high quantile, not
 * the mean: the reservation is what a holder may still GROW to, and the
 * window fills every quantum it leaves (`fleetWindow`'s remainder has no
 * other slack). Not the max: one outlier would pin the work to it for two
 * weeks, while a holder that does outgrow its reservation is charged its
 * measured footprint at the next reading anyway.
 */
export const HOLDER_RESERVE_QUANTILE = 0.95;

/** The reservation of one share of `work` holding `units`, and what it rests on. */
export interface HolderReserve {
  bytes: number;
  basis: ReserveBasis;
  /** The recorded peaks it was derived from (0 when unmeasured). */
  samples: number;
}

/**
 * What a share of `work` holding `units` is reserved, from the peaks recorded
 * for that work (`peaks`: the window's, oldest first).
 *
 * - Too few records (`< MIN_HOLDER_PEAKS`): `units × PER_UNIT_BYTES`, the
 *   whole quantum per slot — what every share was charged before. A work
 *   nobody has measured is reserved as if each unit were the heaviest class.
 * - Otherwise the `HOLDER_RESERVE_QUANTILE` of its peaks — and never below
 *   the largest of its `RECENT_HOLDER_PEAKS` latest — whatever the units:
 *   a holder's peak is set by what it runs, not by how many slots it got (a
 *   1-unit build still runs its 2-unit type-check worker, clamped), so this
 *   may sit above `units × PER_UNIT_BYTES` as well as below.
 */
export function holderReserve(
  units: number,
  peaks: readonly number[],
): HolderReserve {
  if (peaks.length < MIN_HOLDER_PEAKS)
    return {
      bytes: units * PER_UNIT_BYTES,
      basis: "unmeasured",
      samples: 0,
    };
  return {
    bytes: Math.max(
      quantile(peaks, HOLDER_RESERVE_QUANTILE),
      ...peaks.slice(-RECENT_HOLDER_PEAKS),
    ),
    basis: "measured",
    samples: peaks.length,
  };
}

/** Nearest-rank quantile (no interpolation: always a peak that happened). */
function quantile(values: readonly number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1);
  return sorted[Math.max(0, rank)]!;
}

/** Each work's recorded peaks inside the window ending at `nowMs`, in record order. */
export function peaksByWork(
  records: readonly HolderPeakRecord[],
  nowMs: number,
): Map<HolderWork, number[]> {
  const out = new Map<HolderWork, number[]>();
  for (const r of records) {
    if (nowMs - Date.parse(r.t) > HOLDER_PEAK_WINDOW_MS) continue;
    const list = out.get(r.work);
    if (list) list.push(r.peakBytes);
    else out.set(r.work, [r.peakBytes]);
  }
  return out;
}
