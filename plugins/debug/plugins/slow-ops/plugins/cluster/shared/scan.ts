import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import {
  cappedList,
  wholeList,
} from "@plugins/packages/plugins/list-bound/core";
import { SlowOpSchema } from "@plugins/debug/plugins/slow-ops/core";

/**
 * At most this many `slow_ops` rows per worktree — its heaviest by total
 * time. One fork's table holds one row per distinct operation it ever saw
 * slow (main: thousands, each carrying a ten-sample contention ring), so the
 * scan reads its heaviest and counts the rest (`opCount`).
 */
export const CLUSTER_OPS_PER_WORKTREE = 100;

// A cluster row is exactly what the merged view reads (aggregate.ts) — an
// explicit pick mirroring scan-served.ts's SELECT, so a column added to or
// dropped from `slow_ops` never changes what the cross-fork parse expects.
// Selecting nothing else keeps every fork readable whichever schema it is on —
// an un-rebuilt fork with columns since dropped, one older than `variants` /
// `measures`.
export const ClusterSlowOpSchema = SlowOpSchema.pick({
  id: true,
  worktree: true,
  operationKind: true,
  operation: true,
  count: true,
  totalMs: true,
  maxMs: true,
  recentSamples: true,
  lastSeenAt: true,
});
export type ClusterSlowOp = z.infer<typeof ClusterSlowOpSchema>;

// One worktree's contribution to the cluster fan-out. `ops` are its heaviest
// raw per-row `slow_ops` aggregates from its own forked DB — the web layer
// does all the cross-worktree merge (aggregate + timeline) so the merge logic
// stays client-side and unit-testable. On a per-DB failure (old-schema fork,
// stale fork, connection refused) the row is surfaced with `ok: false` +
// `error` rather than blanking the whole view — loud-but-resilient.
export const ClusterWorktreeSchema = z.object({
  name: z.string(),
  ok: z.boolean(),
  error: z.string().optional(),
  /** The heaviest {@link CLUSTER_OPS_PER_WORKTREE} rows, by total time. */
  ops: cappedList(ClusterSlowOpSchema, { max: CLUSTER_OPS_PER_WORKTREE }),
  /** Every row the fork holds (0 for a failed one). */
  opCount: z.number(),
});
export type ClusterWorktree = z.infer<typeof ClusterWorktreeSchema>;

/** The question: the instant the scan was asked for (mount or Refresh). */
export const ClusterScanQuerySchema = z.object({ at: z.number().int() });

/**
 * One cluster scan as it stands: the planned worktree count (`null` until the
 * fork list is read), every worktree that reported so far in arrival order
 * (append-only, so each push ships as a patch), and `complete` once all did.
 *
 * BOUND: one entry per live fork (`listLiveForkDatabases`: main + attempts
 * active or under 24 h old — not every database on the host), each ≤
 * {@link CLUSTER_OPS_PER_WORKTREE} rows.
 */
export const ClusterScanSchema = z.object({
  total: z.number().nullable(),
  worktrees: wholeList(ClusterWorktreeSchema, {
    reason:
      "one entry per live fork (main + attempts active or under 24 h old), not every database on the host",
  }),
  complete: z.boolean(),
});
export type ClusterScan = z.infer<typeof ClusterScanSchema>;

/**
 * Every live worktree DB fork's slow ops, scanned once per question and
 * filled in as each fork answers: pushed (as patches) while the scan runs,
 * unchanged once it is complete — a later look (Refresh) is a new question.
 */
export const clusterScan = liveValue("debug.slow-ops.cluster.scan", {
  schema: ClusterScanSchema,
  query: ClusterScanQuerySchema,
  patches: true,
});
