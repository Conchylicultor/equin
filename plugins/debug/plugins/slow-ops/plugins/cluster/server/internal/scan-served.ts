import { z } from "zod";
import { openShortLivedClient } from "@plugins/database/plugins/admin/server";
import { createSemaphore } from "@plugins/packages/plugins/semaphore/core";
import { queryOne, queryRows } from "@plugins/database/plugins/sql-rows/core";
import { serveValue } from "@plugins/network/plugins/live/server";
import {
  runInBackgroundLane,
  runWithoutProfiling,
} from "@plugins/infra/plugins/runtime-profiler/core";
import {
  CLUSTER_OPS_PER_WORKTREE,
  ClusterSlowOpSchema,
  clusterScan,
  type ClusterScan,
  type ClusterWorktree,
} from "../../shared/scan";
import { listLiveForkDatabases } from "./live-fork-databases";

// Bound the fan-out so a 16-worktree cluster never opens 16 pools at once. Each
// short-lived pool is `max: 1`, so this caps concurrent backends we add to the
// (already-contended) cluster while still parallelising the merge.
const FANOUT_CONCURRENCY = 6;

/**
 * At most about this many pushes per scan: one per `ceil(total / N)` forks,
 * plus the fork list and completion — a ~16-fork cluster pushes every fork
 * (live per-worktree progress), a many-worktree host batches.
 */
const MAX_PUSHES = 40;

// Aliased to the camelCase field names `ClusterSlowOpSchema` declares (exactly
// the slow-op columns the cluster view reads), so the schema that defines a
// slow op on the wire is also the one that parses it off the wire here — ONE
// definition. The types line up with no coercion: `count` is int4, the `_ms`
// columns are float8, `recent_samples` is jsonb, and the timestamps are
// timestamptz, so node-postgres already hands back numbers, decoded objects and
// Dates. The heaviest rows by total time, at most CLUSTER_OPS_PER_WORKTREE.
const SELECT_SLOW_OPS = `
  SELECT id, worktree, operation_kind AS "operationKind", operation, count,
         total_ms AS "totalMs", max_ms AS "maxMs",
         recent_samples AS "recentSamples", last_seen_at AS "lastSeenAt"
  FROM slow_ops
  ORDER BY total_ms DESC
  LIMIT $1
`;
const COUNT_SLOW_OPS = `SELECT count(*)::int AS n FROM slow_ops`;

async function fetchWorktree(name: string): Promise<ClusterWorktree> {
  const pool = openShortLivedClient(name);
  try {
    const [ops, { n }] = await Promise.all([
      queryRows(pool, {
        sql: SELECT_SLOW_OPS,
        params: [CLUSTER_OPS_PER_WORKTREE],
        row: ClusterSlowOpSchema,
      }),
      queryOne(pool, { sql: COUNT_SLOW_OPS, row: z.object({ n: z.number() }) }),
    ]);
    return { name, ok: true, ops, opCount: n };
  } catch (err) {
    // Loud-but-resilient: one stale or old-schema fork (e.g. missing the
    // recent_samples column) must not blank the whole cluster view. Surface the
    // error per-row in the UI instead of swallowing it.
    return { name, ok: false, error: String(err), ops: [], opCount: 0 };
  } finally {
    await pool.end();
  }
}

interface Scan {
  readonly state: ClusterScan;
  failed: unknown;
}

/** The scans a subscriber holds, by question. */
const held = new Map<number, Scan>();

/**
 * Start the fan-out as of `at` (which forks count as live is judged at it),
 * pushing through `push` once the fork list is read, as forks answer (batched
 * to about {@link MAX_PUSHES}) and once more when it completes or fails.
 * Observability, so it runs under the background lane with profiling
 * suppressed.
 */
function startScan(at: number, push: () => void): Scan {
  const scan: Scan = {
    state: { total: null, worktrees: [], complete: false },
    failed: undefined,
  };
  void runInBackgroundLane(() =>
    runWithoutProfiling(async () => {
      try {
        await fanOut(at, scan.state, push);
        scan.state.complete = true;
      } catch (err) {
        // A whole-scan failure (the fork list unreadable): the read rethrows it.
        scan.failed = err;
      }
      push();
    }),
  );
  return scan;
}

/** Read every fork live at `at` into `state`, pushing as forks answer. */
async function fanOut(
  at: number,
  state: ClusterScan,
  push: () => void,
): Promise<void> {
  const names = await listLiveForkDatabases(at);
  state.total = names.length;
  push();
  const pushEvery = Math.max(1, Math.ceil(names.length / MAX_PUSHES));
  let sincePush = 0;
  const semaphore = createSemaphore(FANOUT_CONCURRENCY);
  await Promise.all(
    names.map((name) =>
      semaphore.run(async () => {
        state.worktrees.push(await fetchWorktree(name));
        if (++sincePush >= pushEvery) {
          sincePush = 0;
          push();
        }
      }),
    ),
  );
}

/** The scan's answer as it stands — or its failure. */
function answerOf(scan: Scan): ClusterScan {
  if (scan.failed !== undefined) throw scan.failed;
  return { ...scan.state, worktrees: [...scan.state.worktrees] };
}

/**
 * The cluster scan, external `"notified"`: the truth is every live fork DB's
 * own `slow_ops`, which no change feed of this backend sees — so it is read
 * ONCE per question (the instant `at` it was asked) while a reader holds it:
 * the question's first subscriber starts the fan-out and each fork's answer
 * pushes the value forward (as patches: the worktree list is append-only)
 * until it completes; then nothing moves it. Refresh is a new question.
 * Dropped at the last unsubscribe (a fan-out still running finishes into
 * nothing). The loader only reads the held scan — the fan-out (fork list
 * included) is the subscription's, never a load's — so a read with no
 * subscription behind it fails loud.
 */
export const clusterScanServed = serveValue(clusterScan, {
  source: "external",
  changes: "notified",
  loader: ({ at }) => {
    const scan = held.get(at);
    if (scan === undefined)
      throw new Error(
        `no cluster scan is open for ${at} — a scan is read through a subscription, whose first subscriber starts it`,
      );
    return answerOf(scan);
  },
  whileSubscribed: ({ at }, notify) => {
    let reading = true;
    const scan = startScan(at, () => {
      if (reading) notify();
    });
    held.set(at, scan);
    return () => {
      reading = false;
      if (held.get(at) === scan) held.delete(at);
    };
  },
});
