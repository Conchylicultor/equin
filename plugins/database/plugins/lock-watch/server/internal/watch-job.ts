import { z } from "zod";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { recordReport } from "@plugins/reports/plugins/engine/server";
import { openShortLivedClient } from "@plugins/database/plugins/admin/server";
import { dbLog } from "@plugins/database/server";
import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import {
  DB_LOCK_HOLDER_KIND,
  LOCK_WATCH_THRESHOLD_MS,
  lockHolders,
  type LockWatchObservation,
} from "../../core";
import { readSessions } from "./read-sessions";
import { lockHolderMessage } from "./render";
import { publishObservation } from "./state";

// The lock watch: once a minute, who on this worktree's database holds other
// sessions back, or sits idle inside a transaction, past the bound.
//
// A schedule, not a push: Postgres has no change signal for lock waits or for
// a session going idle in a transaction — no NOTIFY, no trigger, no hook — so
// the only way to see one is to look. `pg_stat_activity` + `pg_blocking_pids`
// once a minute is the cheapest look there is.
//
// It READS on a connection of its own, straight to Postgres
// (`openShortLivedClient`: never pgbouncer), so a wedge that has taken every
// pgbouncer slot — the 2026-11-03 incident — is still seen. Publishing the
// look, the `db.jsonl` line and only then the reports, unawaited: they are
// written through `db`, the very pool a wedge starves.
//
// It never ends a session. Its job is to name the code that left a transaction
// open so that code gets fixed; terminating the session would make the symptom
// go away and leave the cause where it is.
//
// `perWorktree`: every worktree's backend watches its own database, and holds
// its own latest look in memory (`state.ts`).
export const lockWatchJob = defineJob({
  name: "database.lock-watch",
  description:
    "Looks once a minute for database sessions holding others back or idling inside a transaction, and reports which code they belong to.",
  hold: "instant",
  input: z.object({}),
  event: z.never(),
  dedup: "singleton",
  schedule: { cron: "* * * * *", perWorktree: true },
  maxAttempts: 1,
  run: async () => {
    const pool = openShortLivedClient(runtimeNamespace());
    const rows = await readSessions(pool).finally(() => pool.end());
    const observation: LockWatchObservation = {
      observedAt: Date.now(),
      thresholdMs: LOCK_WATCH_THRESHOLD_MS,
      holders: lockHolders(rows, LOCK_WATCH_THRESHOLD_MS),
    };
    publishObservation(observation);

    const reports = observation.holders.map((h) => {
      const data = { ...h, thresholdMs: observation.thresholdMs };
      return { data, message: lockHolderMessage(data) };
    });
    for (const r of reports) {
      dbLog.publish(`[lock-watch] ${r.message}`, "stderr");
    }
    // Not awaited: the write goes through `db`, the pool a wedge starves, and
    // a write stuck for its 60 s deadline must not hold this singleton job
    // past the next minute's look. Each write is bounded by that deadline; a
    // failed one rejects loudly.
    for (const r of reports) {
      void recordReport({
        kind: DB_LOCK_HOLDER_KIND,
        source: "server-db-lock-watch",
        data: r.data,
        message: r.message,
      });
    }
  },
});
