import type { BackupRunStatus } from "@plugins/backup/core";
import type { RunOutcome } from "@plugins/runs/plugins/run-outcome/core";

/**
 * The shared outcome each value `backup_runs.status` can hold means (the
 * statuses are `backup/core`'s `BACKUP_RUN_STATUSES`).
 *
 * Written as a map rather than a `CASE` in the arm's SQL, because a `CASE`
 * is a place a branch can go missing: the union query validates each row's
 * outcome against the shared vocabulary, so a status nobody mapped comes back
 * as `NULL` and throws the whole page. Here the map's value type is
 * {@link RunOutcome}, so an unmapped outcome is a `tsc` error, and the server
 * builds its `CASE` by folding over these entries — the branch set and the
 * status set are one declaration and cannot come apart.
 *
 * `partial` maps through rather than collapsing into `failed`. Backup is the
 * only kind of run that can half-succeed — three targets of four — and that is
 * precisely why the shared vocabulary has a `partial` at all.
 */
export const BACKUP_STATUS_OUTCOME = {
  running: "running",
  ok: "succeeded",
  partial: "partial",
  failed: "failed",
} as const satisfies Record<BackupRunStatus, RunOutcome>;
