import { z } from "zod";

// Pure helpers for the sentinel tick — kept IO-free so they are bun-testable.

/**
 * Row shape of the one batched pg-stats round trip (see worker/pg.ts), as the
 * columns' real Postgres types decode:
 *
 * - the three `count(*)`s are `int8`, which node-postgres hands back as
 *   STRINGS, and a scalar count subquery always yields a row, so never null;
 * - `sum(blk_read_time)` is `float8` — a real number — but `sum` over no rows
 *   is null;
 * - `sum(xact_commit)` sums `bigint` into `numeric`, another string, nullable
 *   for the same reason;
 * - `json_object_agg` decodes to an object, null when no backend is waiting.
 *
 * `mapPgStatsRow` is what turns the strings into numbers.
 */
export const PgStatsRowSchema = z.object({
  locks_waiting: z.string(),
  blk_read_time: z.number().nullable(),
  xact_commit: z.string().nullable(),
  wait_events: z.record(z.string(), z.number()).nullable(),
  active_backends: z.string(),
  total_backends: z.string(),
});
export type PgStatsRow = z.infer<typeof PgStatsRowSchema>;

export interface PgStats {
  locksWaiting: number;
  blkReadTimeMs: number;
  xactCommit: number;
  waitEvents: Record<string, number>;
  activeBackends: number;
  totalBackends: number;
}

export function mapPgStatsRow(row: PgStatsRow): PgStats {
  return {
    locksWaiting: Number(row.locks_waiting),
    blkReadTimeMs: row.blk_read_time ?? 0,
    xactCommit: Number(row.xact_commit ?? 0),
    waitEvents: row.wait_events ?? {},
    activeBackends: Number(row.active_backends),
    totalBackends: Number(row.total_backends),
  };
}

/**
 * Per-tick delta against the previous cumulative reading. Null when there is
 * no baseline (first tick) — a counter reset (pg restart) would read negative,
 * which also yields null rather than a bogus spike.
 */
export function counterDelta(
  prev: number | null,
  current: number,
): number | null {
  if (prev === null) return null;
  const delta = current - prev;
  return delta < 0 ? null : delta;
}

/**
 * Counts singularity build/check/push CLI processes in a `ps -axo command=`
 * listing. Matches the CLI invocation shapes (`./singularity build`,
 * `singularity check ...`) while excluding this scan itself (`ps`) and
 * unrelated mentions (paths containing the word inside another token).
 */
export function countBuildProcesses(psOutput: string): number {
  let n = 0;
  for (const line of psOutput.split("\n")) {
    if (/(^|\/|\s)singularity\s+(build|check|push)\b/.test(line)) n++;
  }
  return n;
}

/** One free-space reading of the home volume, at its wall clock. */
export interface FreeSpacePoint {
  wall: number;
  freeBytes: number;
}

/** The window the fill rate is measured over. */
export const FILL_WINDOW_MS = 2 * 60 * 1000;
/** The rate reads null until the readings span at least this much. */
export const FILL_MIN_SPAN_MS = 60 * 1000;

/**
 * Appends `point` to the rolling free-space window (dropping what is older than
 * {@link FILL_WINDOW_MS}) and returns how fast free space fell across it, in
 * bytes/s — null while the window spans less than {@link FILL_MIN_SPAN_MS}.
 * A two-point difference, not a fit: a burst that comes back (a build's temp
 * files) cancels out, and a steady fill shows in full.
 */
export function pushFreeSpace(
  window: FreeSpacePoint[],
  point: FreeSpacePoint,
): number | null {
  window.push(point);
  while (window.length > 1 && point.wall - window[0]!.wall > FILL_WINDOW_MS)
    window.shift();
  const oldest = window[0]!;
  const spanMs = point.wall - oldest.wall;
  if (spanMs < FILL_MIN_SPAN_MS) return null;
  return ((oldest.freeBytes - point.freeBytes) / spanMs) * 1000;
}
