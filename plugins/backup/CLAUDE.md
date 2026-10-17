# backup

## The backup runs OUT OF PROCESS

`backup.run.supervised` is a `defineSupervisedJob`: it claims the ledger row,
spawns `./singularity supervised-exec backup.run.supervised` **detached**, and
suspends. So a backend restart mid-`tar` no longer kills the backup — the child
outlives it and whichever backend is up when the exit marker lands records the
outcome. The body is the job's `run` (`backup-body.ts`), which the child calls;
the job keeps its own ledger (`backup_runs`), which the child writes itself.

Three consequences that look like bugs and are not:

- **`reconcileBackups` writes to no table.** Its old second arm marked every
  unfinished row failed at boot, which would now kill the very backup that
  survived the restart. Closing rows is `closeBackupRow`, driven by the child's
  own exit marker. The filesystem sweep it still does is skipped entirely while
  a backup's pid is alive, for the same reason.
- **The cron is on the job itself** (`schedule` on `backup.run.supervised`, so
  it is `dedup: "singleton"`: one pending row, and a manual enqueue landing on a
  pending tick's row takes its payload). A run's identity is its queue row, so a
  scheduled supervised job cannot replay an earlier run's steps. A tick that
  fires while a backup is running loses the claim and returns.
- **`backup_runs.namespace` exists but the runs arm still reports `null`.** The
  column scopes `listUnfinished` (a worktree DB is a fork of main's and inherits
  its rows) and gives the in-flight unique index something to contend on. It is
  not a claim that a backup belongs to a worktree; a backup is host-global.
- **`runAttempts: 2` is not the odd one out by accident.** Every other supervised
  kind keeps the default 1; backup's old job carried `maxAttempts: 2`, so this
  preserves what it had. A backup's likeliest failure is the upload leg, and the
  fallback is the nightly schedule — one blip would otherwise cost a whole day.

Overlap is prevented by `backup_runs_inflight_uniq`, not by the queue: the
claiming INSERT is the lock. The run directory is named for the second the
assembly started, so `assembleArchive` creates it non-recursively and fails loud
on `EEXIST` rather than letting two runs share a staging tree and an archive
path — unreachable today, silent corruption if it ever is not.

## A source that fails costs the archive that source, and nothing else

Every source is assembled on its own and a thrower is recorded, not propagated.
`assembleArchive` runs each `BackupSource.assemble` inside its own `try`, and a
source that throws becomes a `failed` report in the manifest carrying its own
words; `assembleDatabases` does the same one level down, per database.

This is not a nicety. Both layers used to be a bare `Promise.all`, so ONE
rejection took the whole run: on 2026-09-18 and 2026-09-19 a composition
database that had not booted since the migration dropping
`mail_drafts.thread_id` still carried the constraint, the exclusion planner
rightly refused to dump it, and the machine went three nights with no archive at
all — no attachments, no secrets, no transcripts — because of a database holding
zero rows. The cluster will always hold databases this repo's schema does not
describe (dormant composition forks, leaked test databases), so this is a
standing condition, not an incident.

Three rules hold it together:

- **A source's outcome is a union, not a `skipped` boolean.** `included` /
  `skipped` / `failed` (`backup/core`), so a consumer cannot render a failed
  source as a fine one by forgetting an optional field. `failed` still carries
  `items` and `sizeBytes`, because a source can fail PART way and what it wrote
  is really in the archive.
- **A failed source keeps the run off `ok`.** `backup-body` folds source
  failures into the status beside the target tally. Before, the status came from
  targets alone, so a run whose databases source blew up and whose uploads then
  went fine recorded `ok`.
- **A partial dump is deleted, never archived.** A killed `pg_dump` leaves a
  truncated custom-format file that `pg_restore` only discovers is short while
  someone is restoring it. `assembleDatabases` reclaims it on the error path, so
  the archive holds a whole dump or no file.

The 2026-09-18 refusal itself is gone too. `assembleDatabases` now backs up only an
app's own databases — main, and each composition served from main (its
`composition.json` marker) — and lists the rest under **Not backed up** on the
run card: worktree copies, test databases and fork temps as one line of counts,
and every orphan (no app owns it, nothing reclaims it) by name. Only the running
namespace's own database is planned strictly; any other may be on an older
schema, so a link into a declared table keeps that table's rows there and the
card says so (`planBackupExclusions` in `database/admin`).

Manifests are **v3**. v2 rows (`skipped: boolean`) are still read — the boolean
maps onto `included` / `skipped` losslessly, since v2 had no way to say `failed`
— by both decoders and by the runs arm's `sourceCountExpr`. `backupSourceWentIn`
in `backup/core` is the one reading of "did this source put anything in the
archive", so the list and the count cannot disagree.

## The gap now reaches the alert funnel

A run that does not end `ok` files a **`backup-incomplete`** report. It did not
before, and that was the bug behind the bug: three nights of failure showed up
only in the backup pane, so the way anyone found out was by going and looking.

The child writes it through the **outbox** (`reports/plugins/outbox`), not
`recordReport`. It does hold a database connection, but the reports engine is
more than a row — its velocity window, fan-out ceiling and shed buffer are
per-process in-memory state, and a process that exits seconds later would dedupe
against nothing. The kind is registered by `backup/server` so MAIN's drain can
resolve it.

It dedupes on WHAT is missing rather than on the run, so a standing gap is one
row with a rising count and a new source starting to fail mints its own.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Backup orchestrator UI: run backups, view history, and open one run's detail pane — whose sections (what went into the archive, where it was dispatched to, and the Grant access repair for a target that lost its OAuth token) are contributed by the backup arm. Backup orchestrator: assembles archives from registered backup sources, dispatches to registered storage targets. The assembly runs OUT OF PROCESS as a supervised job's `run` body, so a backend restart mid-`tar` no longer kills the backup.
- Web:
  - Slots:
    - `BackupRunDetail.Section`
    - `backupPane.Actions`
    - `backupRunPane.Actions`
  - Slot contributors:
    - `BackupRunDetail.Section` ← `backup.runs-arm`
    - `backupPane.Actions` ← `primitives.pane`
    - `backupRunPane.Actions` ← `primitives.pane`
  - Contributes:
    - `ConfigV2.WebRegister` "config"
    - `Pane.Register` "backup"
    - `Pane.Register` "backup-run"
    - `DebugApp.Sidebar` "Backup"
  - Uses:
    - `apps/debug/shell.DebugApp`
    - `config_v2.ConfigV2`
    - `config_v2/config-link.ConfigGearButton`
    - `infra/endpoints.useEndpointMutation`
    - `primitives/css/rail.useRailGuard`
    - `primitives/css/rigid.rigidClass`
    - `primitives/css/spacing.selfClass`
    - `primitives/css/spacing.Stack`
    - `primitives/css/text.Text`
    - `primitives/css/ui-kit.Button`
    - `primitives/detail-sections.defineDetailSections`
    - `primitives/loading.Loading`
    - `primitives/pane.Pane`
    - `primitives/pane.PaneChrome`
    - `primitives/pane.ResolveResult`
    - `primitives/pane.resolveRow`
    - `primitives/pane.rowOrStale`
    - `runs.RunsDataView`
    - `runs.useRun`
    - `ui/icons.Icon`
  - Exports (values):
    - `backupPane`
    - `BackupRunDetail`
    - `backupRunPane`
- Server:
  - Contributes:
    - `ConfigV2.Register` "config"
    - `taskCategory` "backup"
    - `report-kind` "backup-incomplete"
  - Uses:
    - `config_v2.ConfigV2`
    - `config_v2.getConfig`
    - `database.db`
    - `infra/endpoints.implement`
    - `infra/entities.defaultNow`
    - `infra/entities.defineEntity`
    - `infra/jobs/supervised-job.defineSupervisedJob`
    - `infra/paths.BACKUPS_DIR`
    - `primitives/log-channels.Log`
    - `reports.recordReport`
    - `reports.ReportKind`
    - `tasks/task-category.TaskCategory`
  - DB schema: `plugins/backup/server/internal/tables.ts`
  - Exports (types): `BackupIncompletePayload`
  - Exports (values):
    - `_backupRuns`
    - `backupIncompleteKind`
    - `BackupSource`
    - `BackupTarget`
  - Register: `defineSupervisedJob('backup.run.supervised')`
  - Routes: `POST /api/backup/run`
- Core:
  - Uses:
    - `fields.FieldsRecord`
    - `fields.nullable`
    - `fields/date/config.dateField`
    - `fields/int/config.intField`
    - `fields/json/config.jsonField`
    - `fields/text/config.textField`
    - `infra/entities.entityRef`
    - `primitives/pane.defineRoute`
  - Exports (types):
    - `BackupArchive`
    - `BackupManifest`
    - `BackupSourceFailed`
    - `BackupSourceIncluded`
    - `BackupSourceItem`
    - `BackupSourceOutcome`
    - `BackupSourceReport`
    - `BackupSourceSkipped`
    - `BackupTargetResult`
  - Exports (values):
    - `BACKUP_CATEGORY_ID`
    - `BACKUP_RUN_KIND`
    - `BackupManifestSchema`
    - `backupRoute`
    - `backupRunFields`
    - `backupRunRoute`
    - `backupRunsEntityRef`
    - `BackupSourceReportSchema`
    - `backupSourceWentIn`
    - `BackupTargetResultSchema`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --muted-foreground`
    - `ui/tokens/density --chrome-pad-x`
    - `ui/tokens/density --space-lg`
    - `ui/tokens/density --space-xl`
    - `ui/tokens/shape --spacing`
  - Imported by:
    - `apps/chord/song-index`
    - `backup/runs-arm`
    - `backup/sources/attachments`
    - `backup/sources/claude-settings`
    - `backup/sources/config`
    - `backup/sources/cost-history`
    - `backup/sources/databases`
    - `backup/sources/project-memory`
    - `backup/sources/prototypes`
    - `backup/sources/secrets`
    - `backup/sources/singularity-platform`
    - `backup/sources/transcripts`
    - `backup/targets/google-drive`
    - `backup/targets/local`
- Exemptions:
  - Exempts itself from: `ids:pk-declared` — `server/internal/tables.ts` (debt)
- Shared:
  - Exports (values): `runBackup`
- Sub-plugins:
  - **`runs-arm`** — The backup arm's presence on the merged run surface: its rows' link into the backup run-detail pane, its four scalar columns (native status, archive size, source and target counts) as real…
  - **`sources`** — Umbrella for pluggable backup sources, each a self-gating sub-plugin contributing a BackupSource.
    - Plugins:
      - **`attachments`** — Config UI for the attachments backup source. Backs up file attachments into the backup archive.
      - **`claude-settings`** — Config UI for the Claude settings backup source. Backs up Claude CLI settings and history into the backup archive.
      - **`config`** — Config UI for the config backup source. Backs up Singularity config files into the backup archive.
      - **`cost-history`** — Config UI for the cost-history backup source. Backs up the permanent cost-history archive (year-sharded session records and the merged price table) into the backup archive.
      - **`databases`** — Config UI for the databases backup source. Backs up worktree databases into the backup archive.
      - **`project-memory`** — Config UI for the project memory backup source. Backs up Claude Code project memory files into the backup archive.
      - **`prototypes`** — Config UI for the prototypes backup source. Backs up the throwaway UI prototypes into the backup archive — they live outside git on purpose, so this is what makes them recoverable.
      - **`secrets`** — Config UI for the secrets backup source. Backs up encrypted secrets into the backup archive.
      - **`singularity-platform`** — Config UI for the Singularity platform backup source. Backs up Singularity platform files (auth, database config) into the backup archive.
      - **`transcripts`** — Config UI for the transcripts backup source. Backs up retained-conversation transcripts (active, plus every conversation of a held task) into the backup archive.
  - **`targets`** — Umbrella for pluggable backup targets, each a self-gating sub-plugin contributing a BackupTarget.
    - Plugins:
      - **`google-drive`** — Config UI for Google Drive backup target. Uploads backup archives to Google Drive.
      - **`local`** — Config UI for local backup target. Stores backup archives on the local filesystem.

<!-- AUTOGENERATED:END -->
