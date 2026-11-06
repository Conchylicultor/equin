import { z } from "zod";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { recordReport } from "@plugins/reports/plugins/engine/server";
import { openShortLivedClient } from "@plugins/database/plugins/admin/server";
import { dbLog } from "@plugins/database/server";
import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import {
  DB_IDLE_TRANSACTION_ENDED_KIND,
  DB_LOCK_HOLDER_KIND,
  LOCK_WATCH_THRESHOLD_MS,
  lockHolders,
  type LockWatchObservation,
} from "../../core";
import { readClusterActivity } from "./cluster-activity";
import { CONNECT_STALL_MS, probeNewConnection } from "./connect-probe";
import { heldSession } from "./held-session";
import { readSessionEnds, readSessions } from "./read-sessions";
import { lockHolderMessage, stalledConnectLines } from "./render";
import { noticeIdleEnds } from "./idle-ended-watch";
import { idleTransactionEndedMessage } from "./idle-ended-render";
import { publishObservation } from "./state";

// The lock watch: once a minute, who on this worktree's database holds other
// sessions back, or sits idle inside a transaction, past the bound.
//
// A schedule, not a push: Postgres has no change signal for lock waits or for
// a session going idle in a transaction — no NOTIFY, no trigger, no hook — so
// the only way to see one is to look. `pg_stat_activity` + `pg_blocking_pids`
// once a minute is the cheapest look there is.
//
// It READS on a session of its own, straight to Postgres (never pgbouncer), so
// a wedge that has taken every pgbouncer slot — the 2026-11-03 incident — is
// still seen; and HELD between looks (`held-session.ts`), so a stall of new
// connections — 2026-11-04 — does not blind it. Publishing the look, the
// `db.jsonl` line and only then the reports, unawaited: they are written
// through `db`, the very pool a wedge starves.
//
// Then it opens one NEW connection, as the watch always did, as a probe: if
// it has not answered within `CONNECT_STALL_MS`, the held session reads what
// the whole cluster is doing while the stall is on, into `db.jsonl`. The
// probe's own missed deadline fails the job as loudly as before.
//
// It sees the sessions the cluster's idle-in-transaction timeout ended since
// its last look (`idle-ended-watch.ts`) and reports the ones no app client
// owns — the app's own clients report theirs.
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
    const held = await heldSession();
    const rows = await readSessions(held);
    const observedAt = Date.now();
    const observation: LockWatchObservation = {
      observedAt,
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

    // Sessions the cluster's idle-in-transaction timeout ended since the last
    // look. One the app's own client owned is that client's to report (it saw
    // the server's 25P03, with the exact statement): logged here only, so one
    // end is one report. Read after the holders are out, so a failed read
    // cannot cost the look they already made.
    const ends = await readSessionEnds(held);
    for (const end of noticeIdleEnds(rows, ends, observedAt)) {
      const message = idleTransactionEndedMessage(end.data);
      dbLog.publish(
        `[lock-watch] ${message} (pid ${end.data.pid}` +
          `${end.clientReports ? ", reported by its client" : ""})`,
        "stderr",
      );
      if (end.clientReports) continue;
      void recordReport({
        kind: DB_IDLE_TRANSACTION_ENDED_KIND,
        source: "server-db-lock-watch",
        data: end.data,
        message,
      });
    }

    await probeNewConnection({
      stallMs: CONNECT_STALL_MS,
      connect: async () => {
        const probe = await openShortLivedClient(runtimeNamespace());
        try {
          await probe.query("SELECT 1");
        } finally {
          await probe.end();
        }
      },
      onStalled: async (stalledMs) => {
        const activity = await readClusterActivity(held);
        for (const line of stalledConnectLines(stalledMs, activity)) {
          dbLog.publish(line, "stderr");
        }
      },
    });
  },
});
