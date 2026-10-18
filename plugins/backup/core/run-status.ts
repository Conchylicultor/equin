/**
 * Every value `backup_runs.status` can hold, in lifecycle order — the
 * `backup_runs` entity's `status` options, and (in the runs arm) the
 * statuses its outcome map must cover.
 *
 * The four values are what the run's two writers actually write: `running` on
 * the claim, then `ok` / `partial` / `failed` from the child's own per-target
 * tally — or `failed` from `closeBackupRow`, the supervised job's backstop for
 * a child that ended without recording anything.
 */
export const BACKUP_RUN_STATUSES = [
  "running",
  "ok",
  "partial",
  "failed",
] as const;

export type BackupRunStatus = (typeof BACKUP_RUN_STATUSES)[number];
