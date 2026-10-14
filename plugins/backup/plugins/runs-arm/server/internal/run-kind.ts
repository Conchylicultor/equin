import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { expr } from "@plugins/infra/plugins/query-resource/core";
import {
  nullable,
  parsed,
} from "@plugins/database/plugins/sql-projection/server";
import { _backupRuns } from "@plugins/backup/server";
import { defineRunKind } from "@plugins/runs/server";
import { RunOutcomeSchema } from "@plugins/runs/plugins/run-outcome/core";
import {
  BACKUP_RUN_STATUSES,
  BACKUP_STATUS_OUTCOME,
  BackupSourceReportSchema,
  backupRunArm,
  type BackupRunStatus,
} from "../../core";

/**
 * `backup_runs.status` → the shared outcome vocabulary, folded out of the map
 * in `core/`: the branch set IS the status set, so a status added to
 * `backup_runs` without saying what it means fails at `tsc`, and one that
 * escaped it projects NULL, which the arm's `RunOutcomeSchema` decoder refuses.
 */
function outcomeExpr(status: unknown): SQL {
  const branches = Object.entries(BACKUP_STATUS_OUTCOME).map(
    ([from, to]) => sql`when ${from}::text then ${to}::text`,
  );
  return sql`(case ${status} ${sql.join(branches, sql` `)} end)`;
}

/**
 * `backup_runs.status`, read only as one of the statuses `core/` declares:
 * the same fold as {@link outcomeExpr}, each known status mapped to itself.
 */
function statusExpr(status: unknown): SQL {
  const branches = BACKUP_RUN_STATUSES.map(
    (s) => sql`when ${s}::text then ${s}::text`,
  );
  return sql`(case ${status} ${sql.join(branches, sql` `)} end)`;
}

/**
 * How many sources actually went into the archive — the manifest's
 * non-skipped entries. Guarded by `jsonb_typeof`, because v1 rows stored
 * `sources` as an object (the honest answer there is "unknown", not zero).
 * Both manifest shapes count: v3 rows say `outcome` (anything but `skipped`
 * went in), v2 rows say `skipped` — the SQL half of `backupSourceWentIn`.
 */
function sourceCountExpr(manifest: unknown): SQL {
  return sql`(case
    when jsonb_typeof(${manifest} -> 'sources') = 'array' then (
      select count(*)::integer
      from jsonb_array_elements(${manifest} -> 'sources') as s
      where case
        when s ->> 'outcome' is not null then s ->> 'outcome' <> 'skipped'
        else coalesce((s ->> 'skipped')::boolean, false) = false
      end
    )
    else null::integer
  end)`;
}

/**
 * The backup arm of the merged run space.
 *
 * - `namespace` is **null** — a backup is host-global; `backup_runs.namespace`
 *   records who CLAIMED the run (the in-flight index's scope), not what it
 *   covers, and is never read here.
 * - `message` is **null** — a backup's failure words are per target, inside
 *   `target_results`, where the detail pane shows every failed target's own.
 * - `label` is `Backup · N sources`; the archive size is `backup.archiveSize`,
 *   a real sortable column, not part of the title.
 *
 * Its route columns are exactly what it reads: `id`, `trigger`, `started_at`,
 * `finished_at`, `status`, `archive_size_bytes`, `manifest`, `target_results`
 * — so a `pid` write routes nowhere.
 */
export const backupRunKind = defineRunKind({
  columns: backupRunArm,
  from: _backupRuns,
  id: _backupRuns.id,
  base: (j) => ({
    label: expr(
      sql`('Backup' || coalesce(' · ' || ${sourceCountExpr(j.base.manifest)}::text || ' sources', ''))`,
      { decoder: String, sqlType: "text", notNull: true },
    ),
    outcome: expr(outcomeExpr(j.base.status), {
      decoder: parsed(RunOutcomeSchema, "runs.backup.outcome"),
      sqlType: "text",
      notNull: true,
    }),
    trigger: j.base.trigger,
    startedAt: j.base.startedAt,
    finishedAt: j.base.finishedAt,
    namespace: null,
    message: null,
  }),
  extra: (j) => ({
    // The column is plain `text`; the field is the arm's status vocabulary —
    // so it is the same fold as `outcome` (each known status to itself), and a
    // status nobody declared projects NULL, which the decoder refuses, rather
    // than a string the field's type says cannot exist.
    status: expr(statusExpr(j.base.status), {
      decoder: parsed(
        z.enum(BACKUP_RUN_STATUSES as [BackupRunStatus, ...BackupRunStatus[]]),
        "runs.backup.status",
      ),
      sqlType: "text",
      notNull: true,
    }),
    archiveSize: j.base.archiveSizeBytes,
    sourceCount: expr(sourceCountExpr(j.base.manifest), {
      decoder: Number,
      sqlType: "integer",
    }),
    targetCount: expr(
      sql`(case
        when jsonb_typeof(${j.base.targetResults}) = 'array'
          then jsonb_array_length(${j.base.targetResults})
        else null::integer
      end)`,
      { decoder: Number, sqlType: "integer" },
    ),
    targetResults: j.base.targetResults,
    // The manifest's source reports, in their v2+ array form (a v1 object
    // reads null — "unknown"), decoded by the arm's own schema.
    sources: expr(
      sql`(case
        when jsonb_typeof(${j.base.manifest} -> 'sources') = 'array'
          then ${j.base.manifest} -> 'sources'
        else null::jsonb
      end)`,
      {
        decoder: nullable(
          parsed(z.array(BackupSourceReportSchema), "runs.backup.sources"),
        ),
        sqlType: "jsonb",
      },
    ),
  }),
});
