import { z } from "zod";
import { getConfig } from "@plugins/config_v2/server";
import { defineSupervisedJob } from "@plugins/infra/plugins/jobs/plugins/supervised-job/server";
import { BACKUP_RUN_KIND } from "@plugins/backup/core";
import { backupConfig } from "../../shared/config";
import { backupLog } from "./backup-log";
import { runBackupBody } from "./backup-body";
import {
  claimBackupRun,
  closeBackupRow,
  listUnfinishedBackups,
  setBackupPid,
} from "./run-state";

/**
 * One backup, as an ordinary durable job whose body runs in its own process.
 *
 * The handler claims this namespace's single in-flight slot, spawns
 * `./equin supervised-exec backup.run.supervised` detached, and SUSPENDS — it holds a
 * worker slot for milliseconds, not for the length of a `pg_dump` fan-out plus a
 * `tar` plus a Drive upload. Whichever backend is alive when the child's exit
 * marker lands is the one that wakes and records the outcome.
 *
 * **This is what makes a backup survive a restart**, which it never did before:
 * the work is no longer inside the process the deploy, the sleep or the crash
 * takes down. The old boot-time "mark every unfinished row failed" sweep is
 * gone with it — after this change, an unfinished row at boot usually means a
 * backup that is still running.
 *
 * `runAttempts: 2` **preserves what this job already had**, and is not an opt-in
 * to something new: the old `defineJob` carried `maxAttempts: 2`, whose retry
 * re-ran the whole handler body — assemble from scratch, upload from scratch —
 * which is exactly what a second spawn does. The default is 1 everywhere else
 * because build, release and deploy never retried; backup did.
 *
 * It also earns its keep here in a way it would not for the others. A backup's
 * likeliest failure is the upload leg, a network blip reaching Drive, which is
 * the transient class a retry is for — and the fallback if we dropped it is the
 * nightly schedule, so one failure would mean no backup for a whole day.
 */
export const backupRunJob = defineSupervisedJob({
  name: "backup.run.supervised",
  description:
    "Assembles a backup archive of the app's data and uploads it to the configured storage targets.",
  input: z.object({
    // Defaulted so a caller that carries no input runs as "periodic".
    trigger: z.enum(["manual", "periodic"]).default("periodic"),
  }),

  channel: backupLog,

  ledger: {
    kindId: BACKUP_RUN_KIND,
    claim: (input) => claimBackupRun(input.trigger),
    listUnfinished: listUnfinishedBackups,
    setPid: setBackupPid,
    // The bare terminal stamp for a row the child never closed, and nothing
    // else. There is no `onReattach`: a backup keeps no in-memory live view —
    // its UI reads the ledger row, and the primitive has already restarted the
    // transcript tail by the time `onReattach` would be called.
    closeRow: closeBackupRow,
  },

  // The `run` body: a backup has no command line of its own, so the child is
  // `./equin supervised-exec` running this function. The child writes its
  // own row (manifest, sizes, per-target results, `finished_at`) as its last
  // act, which is why there is no `onEnded`: nothing outside the archive
  // changes when a backup finishes, and `closeRow` covers a child that never
  // got that far.
  run: (input, { runId }) => runBackupBody(runId, input.trigger),

  // The nightly tick, on the job itself. Recur on the user-configured cron;
  // empty disables. Read once at worker startup (a change takes effect on the
  // next restart). Main-only, because `perWorktree` is left off: `BACKUPS_DIR`
  // is host-global, and one tick per live worktree would mean N archives and N
  // uploads of the same machine. The cron payload is `input.parse({})`, which
  // the `trigger` default makes `periodic`. A tick that fires while a backup is
  // running loses the claim and returns.
  schedule: {
    cron: () => getConfig(backupConfig).periodicCron.trim() || null,
  },

  // Two spawns at most, each a genuinely fresh run: `spawn` calls `claim` again,
  // so attempt 2 gets a new uuid, a new transcript and a new marker. Before it
  // claims, the ladder waits a durable backoff and closes attempt 1's row, so
  // the claim cannot lose to it.
  runAttempts: 2,
});
