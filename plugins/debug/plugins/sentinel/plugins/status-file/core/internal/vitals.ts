import { z } from "zod";
import { DiskReadingSchema } from "./disk";

// The machine watcher's latest reading — the host-global `vitals.json` beside
// the `status.<pid>.json` files. The sentinel WORKER writes it every tick (not main), so the
// file carries exactly the readings, limits and trip state the onset detector
// acted on: a wedged main cannot make the health row lie, and a dead worker
// makes the file stop changing, which the row shows as stale.
// Design: research/2026-09-17-global-machine-watcher-row-stats.md.

/**
 * The signals that can trip duress — the detector's own names, a closed set.
 * Adding a detector signal is a type error at every site that maps the set.
 *
 * Each one measures real trouble: memory thrash, database pressure, or slow
 * backends. The load average is not one of them. It counts runnable threads,
 * throttled background ones included, so it read 2× the core count with the
 * CPU half idle and main's event loop at 4 ms. It is context only
 * (research/2026-10-28-global-duress-trip-on-real-trouble.md).
 */
export const SignalKeySchema = z.enum([
  "decompressionsPerSec",
  "locksWaiting",
  "blkReadDeltaMs",
  "slowBackends",
]);
export type SignalKey = z.infer<typeof SignalKeySchema>;
export const SIGNAL_KEYS: readonly SignalKey[] = SignalKeySchema.options;

/** One signal at a tick: its reading (null when unreadable) and its trip limit. */
export const SignalVitalSchema = z.object({
  value: z.number().nullable(),
  limit: z.number(),
});
export type SignalVital = z.infer<typeof SignalVitalSchema>;

export const SentinelVitalsRecordSchema = z.object({
  /** The watcher's process (main's pid — the worker shares it). */
  pid: z.number().int().positive(),
  /** The sample's wall clock (epoch ms). */
  wall: z.number(),
  /** The tick interval, so a reader can tell a late reading from a stale one. */
  cadenceMs: z.number(),
  signals: z.object({
    decompressionsPerSec: SignalVitalSchema,
    locksWaiting: SignalVitalSchema,
    blkReadDeltaMs: SignalVitalSchema,
    slowBackends: SignalVitalSchema,
  }),
  /** Signals at or above their limit this tick — each signal at most once. */
  elevated: z.array(SignalKeySchema).max(SIGNAL_KEYS.length),
  /**
   * Signals not calm yet this tick (at or above their clear limit): what keeps
   * a tripped episode going, so it outlives `elevated` once a signal falls
   * between its clear and trip limits. Defaults to empty so a file written by
   * a watcher that predates it still parses.
   */
  holding: z.array(SignalKeySchema).max(SIGNAL_KEYS.length).default([]),
  /** The detector is mid-episode after this tick. */
  tripped: z.boolean(),
  /** Machine context that cannot trip duress by itself. */
  context: z.object({
    /**
     * 1-minute load average ÷ CPU count. Defaults to null so a file written
     * by a watcher that predates the reading still parses.
     */
    loadRatio: z.number().nullable().default(null),
    freeMemMb: z.number().nullable(),
    inFlightBuilds: z.number().nullable(),
    runningBackends: z.number().nullable(),
    /**
     * The home volume; null when unreadable this tick. Defaults to null so a
     * file written by a watcher that predates the reading still parses.
     */
    disk: DiskReadingSchema.nullable().default(null),
  }),
});
export type SentinelVitalsRecord = z.infer<typeof SentinelVitalsRecordSchema>;
