import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { SlowOpSchema } from "@plugins/debug/plugins/slow-ops/core";

// One worktree's contribution to the cluster fan-out. `ops` are the raw per-row
// `slow_ops` aggregates from that worktree's own forked DB — the web layer does
// all the cross-worktree merge (aggregate + timeline) so the merge logic stays
// client-side and unit-testable. On a per-DB failure (old-schema fork, stale
// fork, connection refused) the row is surfaced with `ok: false` + `error`
// rather than blanking the whole view — loud-but-resilient. The client parses
// each streamed `worktree` NDJSON frame with this schema.
//
// A cluster row is exactly what the merged view reads (aggregate.ts) — an
// explicit pick mirroring handle-cluster.ts's SELECT, so a column added to or
// dropped from `slow_ops` never changes what the cross-fork parse expects.
// Selecting nothing else keeps every fork readable whichever schema it is on:
// one still carrying the legacy `callers` column, one that has dropped it, one
// older than `variants` / `measures`.
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

export const ClusterWorktreeSchema = z.object({
  name: z.string(),
  ok: z.boolean(),
  error: z.string().optional(),
  ops: z.array(ClusterSlowOpSchema),
});
export type ClusterWorktree = z.infer<typeof ClusterWorktreeSchema>;

// PULL, user-triggered (Refresh button) — never live/polled. A cross-worktree
// fan-out is too heavy and too rarely needed to run on a live resource. Streamed
// as NDJSON (no `response` schema) — see server/internal/handle-cluster.ts —
// so the client can render worktrees progressively and show determinate
// "scanning X / N" progress instead of waiting 20s+ for the whole response.
export const getSlowOpsCluster = defineEndpoint({
  route: "GET /api/slow-ops/cluster",
});
