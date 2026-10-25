import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import {
  cappedList,
  wholeList,
} from "@plugins/packages/plugins/list-bound/core";
import { TimelineEventSchema, TimelineSourceSchema } from "../core";
import { TimelineHealthFrameSchema } from "./frames";

/**
 * At most this many events per (source, worktree) cell — the newest by start.
 * A cell's events grow with the lookback (24 h of traces on a busy fork), so
 * the scan keeps the newest and counts the rest in `omitted`.
 */
export const TIMELINE_CELL_EVENT_CAP = 500;

/**
 * The question: the `lookbackMs` preset ending at `at`, the instant the scan
 * was asked for (the reader's clock on mount, Refresh or a preset change). A
 * new instant is a new question — a new scan; the window stays frozen at it.
 */
export const TimelineScanQuerySchema = z.object({
  lookbackMs: z.number().int(),
  at: z.number().int(),
});
export type TimelineScanQuery = z.infer<typeof TimelineScanQuerySchema>;

/**
 * One fan-out cell that carried something: an ok cell with ≥1 event in the
 * window (an empty one adds no lane, so it is counted in `done` and dropped),
 * or a failed one — a saturated / dropped / old-schema fork surfaces as an
 * error row instead of blanking the timeline. `worktree` is the fork DB name
 * (fork DB names ARE worktree slugs) or the worktree log-dir name.
 */
export const TimelineCellSchema = z.discriminatedUnion("ok", [
  z.object({
    source: TimelineSourceSchema,
    worktree: z.string(),
    ok: z.literal(true),
    /** The newest {@link TIMELINE_CELL_EVENT_CAP} events, by start. */
    events: cappedList(TimelineEventSchema, { max: TIMELINE_CELL_EVENT_CAP }),
    /** Events in the window past the cap. */
    omitted: z.number(),
  }),
  z.object({
    source: TimelineSourceSchema,
    worktree: z.string(),
    ok: z.literal(false),
    error: z.string(),
  }),
]);
export type TimelineCell = z.infer<typeof TimelineCellSchema>;

/**
 * One timeline scan as it stands: the fan-out's progress (`total` planned
 * cells, `done` resolved, `complete` once every cell and health lane is in),
 * the cells that carried something and the health series, each list in
 * arrival order (append-only, so each push ships as a patch).
 *
 * BOUND: cells ≤ live forks × 4 DB sources + the worktrees with a boot in the
 * window + 1 (duress), each ≤ {@link TIMELINE_CELL_EVENT_CAP} events; health
 * ≤ one frame per lane with samples in the window, ≤ ~500 points each
 * (downsampled). The fork list is `listLiveForkDatabases` (main + attempts
 * active or under 24 h old), not every database on the host.
 */
export const TimelineScanSchema = z.object({
  fromMs: z.number(),
  toMs: z.number(),
  /** Planned cell count; `null` until the fork list is read. */
  total: z.number().nullable(),
  /** Cells resolved so far, empty ones included. */
  done: z.number(),
  complete: z.boolean(),
  cells: wholeList(TimelineCellSchema, {
    reason:
      "≤ live forks × 4 DB sources + the worktrees with a boot in the window + 1 (duress) — the live forks only, not every database on the host",
  }),
  health: wholeList(TimelineHealthFrameSchema, {
    reason:
      "one frame per worktree lane with samples in the window, plus the host lane",
  }),
});
export type TimelineScan = z.infer<typeof TimelineScanSchema>;

/**
 * The cross-worktree timeline for one window, filled in progressively as the
 * fan-out resolves: pushed (as patches) while the scan runs, unchanged once it
 * is complete — a new window is a new question. Refused `invalid-window` for a
 * non-positive lookback or one reaching before the epoch.
 */
export const timelineScan = liveValue("debug.timeline.scan", {
  schema: TimelineScanSchema,
  query: TimelineScanQuerySchema,
  patches: true,
  refusals: ["invalid-window"],
});
