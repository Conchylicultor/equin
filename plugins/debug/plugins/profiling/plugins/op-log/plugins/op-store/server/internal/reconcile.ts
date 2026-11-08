import { and, asc, eq, getTableColumns, isNull, lte } from "drizzle-orm";
import {
  orphanedOps,
  reconcilerCompletedEvent,
  type OpEvent,
  type OpFoldState,
  type OpIdentity,
} from "@plugins/debug/plugins/profiling/plugins/op-log/core";
import { readSleepNow } from "@plugins/debug/plugins/profiling/plugins/op-log/server";
import type { SleepNow } from "@plugins/infra/plugins/host/plugins/machine-sleep/core";
import {
  listWorktreeOps,
  probeWorktreeOp,
} from "@plugins/infra/plugins/worktree/server";
import { opRowToFoldState } from "../../core/internal/schemas";
import { readCursor, type OpStoreDb } from "./store";
import { _opLogOps } from "./tables";

// The orphan reconciler: an op hard-killed mid-flight (SIGKILL, OOM, power loss)
// never writes its terminal, so its row would read "in flight" forever. This
// finds the in-flight rows whose process is gone and closes them.
//
// **Main appends; everyone else learns.** The main backend appends a
// `completed{by:"reconciler"}` event to the FILE — never to its own rows — so
// every DB (and `await`, reading the file) learns of the close the same way, by
// ingesting it. A worktree backend does not write the shared log. It closes a
// row locally only when its own ingest had a gap (`gap_at`) and the row predates
// it: main's terminal for that op may be in the bytes it never read.

export type ReconcileCandidate = OpFoldState & { identity: OpIdentity };

export interface ReconcileDeps {
  db: OpStoreDb;
  /** Is this the main backend (the one reconciler that writes the log)? */
  main: boolean;
  /** Is this op's process still running? */
  isLive: (op: ReconcileCandidate) => Promise<boolean>;
  /** Append one event to the op log (main only). */
  append: (event: OpEvent) => Promise<void>;
  now?: () => number;
  /**
   * The machine's sleep clock, stamped on each closing event so the op's last
   * nap is on record. Defaults to the real clock; injectable for tests.
   */
  sleepNow?: () => SleepNow;
}

export interface ReconcileResult {
  /** Terminals appended to the log (main). */
  appended: number;
  /** Rows closed locally as `ingest-gap` (non-main, after a gap). */
  closedLocally: number;
}

/**
 * The most in-flight rows one pass looks at. A real host runs a handful of ops
 * at once; the bound is what keeps a pathological backlog (a long-dead main)
 * from turning one pass into an unbounded scan — the oldest are closed first
 * and the next pass takes the rest.
 */
const MAX_CANDIDATES = 500;

export async function reconcileOps(
  deps: ReconcileDeps,
): Promise<ReconcileResult> {
  const now = deps.now ?? Date.now;
  const sleepNow = deps.sleepNow ?? readSleepNow;
  const cursor = deps.main ? null : await readCursor(deps.db);
  const gapAt = cursor?.gapAt ?? null;
  // A non-main backend closes nothing unless its ingest lost bytes.
  if (!deps.main && gapAt === null) return { appended: 0, closedLocally: 0 };

  const { updatedAt: _updatedAt, ...select } = getTableColumns(_opLogOps);
  const inFlight = isNull(_opLogOps.closedBy);
  const rows = await deps.db
    .select(select)
    .from(_opLogOps)
    .where(
      deps.main || gapAt === null
        ? inFlight
        : and(inFlight, lte(_opLogOps.requestedAt, gapAt)),
    )
    .orderBy(asc(_opLogOps.requestedAt))
    .limit(MAX_CANDIDATES);

  let appended = 0;
  let closedLocally = 0;
  // Every stored row has an identity; `orphanedOps` is the reducer's own
  // statement of "in flight with an identity", so a candidate is exactly that.
  for (const candidate of orphanedOps(rows.map(opRowToFoldState))) {
    if (await deps.isLive(candidate)) continue;
    if (deps.main) {
      await deps.append(reconcilerCompletedEvent(candidate, now(), sleepNow()));
      appended++;
      continue;
    }
    const closed = await deps.db
      .update(_opLogOps)
      .set({
        closedBy: "ingest-gap",
        outcome: "error",
        interrupted: true,
        openWait: null,
      })
      .where(and(eq(_opLogOps.opId, candidate.opId), inFlight))
      .returning({ opId: _opLogOps.opId });
    closedLocally += closed.length;
  }
  return { appended, closedLocally };
}

// ── liveness ────────────────────────────────────────────────────────────────

// Signal 0 checks existence without delivering anything. EPERM: alive, but
// another user's.
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    if (code === "ESRCH") return false;
    throw err;
  }
}

/**
 * Is this op's process still running?
 *
 * 1. Its per-op marker `ops/<opId>.json` in its worktree: locked → live,
 *    unlocked → dead (the kernel dropped the lock with the process — exact, and
 *    immune to pid reuse). This is the answer for every op a current CLI runs.
 * 2. No per-op marker for it — an op from a CLI that predates them (phase 4 of
 *    research/2026-09-29-global-unified-op-status.md), or one whose marker a
 *    reader already reaped. The transition fallback, until phase 5 drops it:
 *    a legacy marker naming this `opId` → live; else a v2 op's own `pid` (from
 *    its `requested`) → alive; else a legacy op (no pid) → live iff its
 *    worktree has ANY live marker, the old slug-level coarseness.
 */
export async function isOpLive(op: ReconcileCandidate): Promise<boolean> {
  const slug = op.identity.opSlug;
  if (slug) {
    const probe = await probeWorktreeOp(slug, op.opId);
    if (probe !== "absent") return probe === "live";
  }
  const markers = slug ? await listWorktreeOps(slug) : [];
  if (markers.some((m) => m.opId === op.opId)) return true;
  if (op.identity.pid !== null) return isPidAlive(op.identity.pid);
  return markers.length > 0;
}
