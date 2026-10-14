# runs-arm (backup)

The backup arm of the unified run space: `backup_runs` bound into the
[`runs`](../../../runs/CLAUDE.md) union, its own columns, and the two sections of
the backup run-detail pane. It lives under `backup` because `backup_runs` is
backup's table; `runs` names no kind.

## Backup is why the shared vocabulary has `partial`

Every other run either did the thing or did not. A backup builds one archive and
dispatches it to N targets, so it can reach two of three. `BACKUP_STATUS_OUTCOME`
maps `partial` straight through.

That map is also how the outcome `CASE` is built. The union validates each row's
outcome against the closed vocabulary, so a hand-written `CASE` missing a native
status yields `NULL` and throws the whole page; folding the branches out of a
`Record<BackupRunStatus, RunOutcome>` makes an unmapped status a `tsc` error.

## The two base columns that read `null`

- **`namespace`** — a backup is host-global; it archives `~/.singularity`, not a
  checkout. Naming the worktree whose backend ran the job would be a fact about
  scheduling dressed as a fact about the backup. The table _does_ have a
  `namespace` column and this is still the right projection — see below.
- **`message`** — a backup has no per-run failure string, only a per-target one,
  and the interesting case is where those disagree. The Targets section shows
  each target's own words instead.

## Deliberately **unscoped**

The build and release arms carry an always-on `where namespace = runtimeNamespace()`,
because a worktree DB is forked from main and inherits main's rows. This arm must
not, and the symmetry is a trap: this arm projects `namespace: null` — a backup
covers the machine — so the predicate would not narrow the arm, it would delete
every backup from the view. `null = 'att-…'` is `NULL`, not `false`, and the
symptom is an empty section reading as "no backups yet".

`backup_runs` _does_ now carry a `namespace` column, and it is not an invitation
to project it. It records which backend CLAIMED the run, so `listUnfinished` can
be scoped away from the rows a worktree inherits in its fork and so the in-flight
unique index has a column to contend on. What the run covers is still the whole
machine.

So the merged view is half-scoped: builds and releases are this-worktree-only,
backups and deploys are everything on the machine. That is the intended shape.

## `BACKUP_RUN_KIND` lives in `backup/core`, not here

The kind string is needed on both sides of an import edge that runs one way:
`backup/web` names a selected row with it (`{ kind, id }`) and owns the run-detail
pane, and this arm needs that pane to open a row into it. With the constant in
this plugin's own `core/`, those two edges close a cycle —
`backup → backup/runs-arm → backup` — and `plugin-boundaries` rejects it.

The reasoning that it is safe because the edges are keyed `zone.runtime` and the
two runtimes differ is **wrong**: the cycle rule collapses to plugin granularity,
with no parent/descendant exception. The build arm learned this by checking the
argument instead of running the check; the check reports it in one line.

The parent's own `core/` breaks it because `backup/web → backup/core` is
intra-plugin and there is no path back. **Do not re-export it from this plugin's
core to shorten an import** — cross-plugin re-exports are banned transitively, and
it would put the edge straight back.

## The disclosure was a missing pane, and the pane is the fix

This arm used to contribute a `Runs.Row`: an expand/collapse card carrying the
per-source reports and the per-target outcomes. It contributed no
`Runs.Kind.open` on purpose, because `Row` infers a `<button>` from an `onClick`
and a custom row lands _inside_ it — so a non-activating row was the only way the
disclosure trigger and the **Grant access** button could be real buttons rather
than buttons nested inside one.

That was a workaround for a surface that did not exist. A run-detail pane
(`backup/web/panes.tsx`, `/debug/backup/br/:runId`) is what the card actually
wanted to be, and once it exists everything the workaround bought comes for free:
the controls sit in ordinary pane content, the row goes back to being a
single-line field row that obeys the Properties panel, and the row activates like
every other kind's.

The three sections are contributed to `BackupRunDetail.Section`, and all are keyed
by the **run** rather than by its id — the pane resolves the row once through
`useRun`, so no section can render an empty-looking body while the read is still
in flight. `useAvailable` is how a section with nothing to show disappears: the
host paints the card before the body, so a `return null` would leave a titled bar
over emptiness. Targets additionally declares `useDefaultOpen` on a failed
target.

**Archive is a one-line section**: it declares no `component`, only a `summary`,
so the host paints one static row with no chevron and nothing to persist. It
reads `backup.archiveSize` through the same `backupArchiveSize` accessor the
DataView's "Archive size" column reads, which is why the line and the column
cannot disagree.

That column is also the ONE arm field of the four that is visible by default. Not
because it is more interesting: it is the only fact a backup row otherwise
carries nowhere. `outcome` says the archive was written and never says whether it
holds a gigabyte or forty bytes, and a nightly backup that quietly halves is a
source that stopped contributing. The other three are each answered better
elsewhere — the native status is `outcome` at a finer grain, and the two counts
are what the Sources and Targets sections *name* rather than count. The cost is
one blank column on every non-backup row, which is the trade.

**Grant access is the only in-app repair path** for a storage target whose OAuth
token expired: without it, a Google Drive backup that lost access reports the
failure forever and offers nothing to do about it. Its `providerId` / `scopes`
come off the target's own `consent` payload, because the grant must be for the
scopes that were actually refused. Do not move it into `itemActions` on the row —
a hover-revealed icon cluster is not where someone whose backup just broke will
look.

## Two smaller rules

- Both `sources` expressions test `jsonb_typeof` first: v1 manifests stored
  `sources` as an object, not an array, and `jsonb_array_length` over one errors
  the whole page. They read `null` ("unknown") for a shape they cannot count.
  The non-skipped filter lives in `web/internal/payload.ts`, applying the same
  reading as the `WHERE` inside the count expression, so the section and the
  number cannot disagree.
- `backup.targetResults` / `backup.sources` are the arm's CARRIED fields
  (`liveArm`'s `carry`): on the slice, never listed, filtered or sorted — a
  jsonb blob has no comparable projection. Every field must be a column; not
  every column need be a listed field. Their schemas
  (`core/internal/payload-schemas.ts`) are the arm slice's own, read through
  `backupRunArm.read(run)`; the server
  decodes `sources` with the same schema (idempotent, so the browser re-parses
  its output). They are second spellings of ones in `backup/shared`
  (plugin-private), pinned by `ZodParser<BackupTargetResult>` /
  `ZodParser<BackupSourceReport>` against `backup/core` so a drift stops
  compiling.
- **Routes gate on what the SQL reads** (`server/internal/run-kind.test.ts`):
  `id`, `trigger`, `started_at`, `finished_at`, `status`,
  `archive_size_bytes`, `manifest`, `target_results` — never `pid` (the
  supervised run's heartbeat) or `namespace` (who claimed it), so those writes
  reach no runs window.

## The blobs ride every listed row

Only the detail pane reads these two columns, yet every row of the window
carries them: a row of the union and a `useRun` point read share ONE
projection, which is what makes a detail row shaped exactly like a listed one.
Trimming the list's payload would need per-read column selection in the union
compiler — a real follow-up, and a bigger change than it looks.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: The backup arm's presence on the merged run surface: the kind's label, its rows' activation into the backup run-detail pane, its four scalar columns (native status, archive size, source and target counts) as real filterable and sortable SQL dimensions, and the three detail sections — the archive's size on one line, the manifest's source reports, and the per-target outcome with its Grant access remediation. The backup arm of the unified run space: binds backup_runs into the runs union — its native status folded into the shared outcome vocabulary (partial included, since backup is the only kind that can half-succeed), a label naming what the run covered, and the source / target counts plus the raw per-target results as its own columns. Reads null for namespace (a backup covers the machine, not a checkout — the table's own namespace column is the in-flight index's scope discriminator, not a fact about the run) and for message (a backup's failure words are per-target).
- Web:
  - Contributes:
    - `Runs.Kind` "backup"
    - `FieldPresentation.Register` "arm:runs:backup"
    - `BackupRunDetail.Section` "Archive"
    - `BackupRunDetail.Section` "Sources" → `BackupSourcesSection`
    - `BackupRunDetail.Section` "Targets" → `BackupTargetsSection`
  - Uses:
    - `auth.GrantAccessButton`
    - `backup.BackupRunDetail`
    - `backup.backupRunPane`
    - `network/live.FieldPresentation`
    - `primitives/css/badge.Badge`
    - `primitives/css/inline.Inline`
    - `primitives/css/rigid.rigidClass`
    - `primitives/css/spacing.Stack`
    - `primitives/css/text.Text`
    - `primitives/css/ui-kit.cn`
    - `runs.Runs`
    - `ui/icons.Icon`
- Server:
  - Uses:
    - `backup._backupRuns`
    - `database/sql-projection.nullable`
    - `database/sql-projection.parsed`
    - `runs.defineRunKind`
  - Register: `defineRunKind('backup')`
- Core:
  - Uses:
    - `backup.BACKUP_RUN_KIND`
    - `fields.nullable`
    - `fields/int/config.intField`
    - `fields/json/config.jsonField`
    - `fields/text/config.enumTextField`
    - `network/live.liveArm`
    - `runs.runs`
  - Exports (types): `BackupRunStatus`
  - Exports (values):
    - `BACKUP_RUN_STATUSES`
    - `BACKUP_STATUS_OUTCOME`
    - `backupRunArm`
    - `BackupSourceReportSchema`
    - `BackupTargetResultSchema`

<!-- AUTOGENERATED:END -->
