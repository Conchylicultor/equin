import { ndjsonResponse } from "@plugins/infra/plugins/ndjson-stream/server";
import { openShortLivedClient } from "@plugins/database/plugins/admin/server";
import { createSemaphore } from "@plugins/packages/plugins/semaphore/core";
import { queryRows } from "@plugins/database/plugins/sql-rows/core";
import {
  ClusterSlowOpSchema,
  type ClusterWorktree,
} from "../../shared/endpoints";
import { listLiveForkDatabases } from "./live-fork-databases";

// Bound the fan-out so a 16-worktree cluster never opens 16 pools at once. Each
// short-lived pool is `max: 1`, so this caps concurrent backends we add to the
// (already-contended) cluster while still parallelising the merge.
const FANOUT_CONCURRENCY = 6;

// Aliased to the camelCase field names `ClusterSlowOpSchema` declares (exactly
// the slow-op columns the cluster view reads), so the schema
// that defines a slow op on the wire is also the one that parses it off the
// wire here — ONE definition, and the read is checked exactly as the live
// resource's is. The types line up with no coercion: `count` is int4, the `_ms`
// columns are float8, `recent_samples` is jsonb, and the timestamps are
// timestamptz, so node-postgres already hands back numbers, decoded objects and
// Dates. (The hand-rolled `RawRow` this replaced declared `number | string` for
// the numeric columns and `Number()`-ed them; nothing ever arrived as a string.)
const SELECT_SLOW_OPS = `
  SELECT id, worktree, operation_kind AS "operationKind", operation, count,
         total_ms AS "totalMs", max_ms AS "maxMs",
         recent_samples AS "recentSamples", last_seen_at AS "lastSeenAt"
  FROM slow_ops
`;

async function fetchWorktree(name: string): Promise<ClusterWorktree> {
  const pool = openShortLivedClient(name);
  try {
    const ops = await queryRows(pool, {
      sql: SELECT_SLOW_OPS,
      row: ClusterSlowOpSchema,
    });
    return { name, ok: true, ops };
  } catch (err) {
    // Loud-but-resilient: one stale or old-schema fork (e.g. missing the
    // recent_samples column) must not blank the whole cluster view. Surface the
    // error per-row in the UI instead of swallowing it.
    return { name, ok: false, error: String(err), ops: [] };
  } finally {
    await pool.end();
  }
}

// Streamed as NDJSON rather than a single JSON response: the fan-out across ~16
// worktree DB forks takes 20s+, so withholding the whole payload until the last
// fork resolves leaves the user staring at a blank pane (and risks Bun's idle
// timeout). Instead we emit a `{ total }` frame up front (after listLiveForkDatabases())
// so the client can show a determinate "scanning X / N worktrees" progress bar,
// then emit each `{ worktree }` as its fetch resolves so the two DataViews fill
// in live. A producer throw is auto-framed as `{ error }` by ndjsonResponse;
// per-DB failures are still surfaced inline as `ok: false` worktree rows.
export function handleSlowOpsCluster(): Response {
  return ndjsonResponse(async (emit) => {
    const names = await listLiveForkDatabases(Date.now());
    emit({ total: names.length });
    const semaphore = createSemaphore(FANOUT_CONCURRENCY);
    await Promise.all(
      names.map((name) =>
        semaphore.run(async () =>
          emit({ worktree: await fetchWorktree(name) }),
        ),
      ),
    );
    emit({ end: true });
  });
}
