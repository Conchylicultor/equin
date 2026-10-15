# Investigate failed records — one action, attached by construction

## Context

Failed rows are everywhere (background jobs, builds, deploys, backups, releases,
events sources, claude-cli calls, …) but only a handful offer "launch an agent to
debug this", and each one that does is hand-rolled:

| Surface | Trigger | Icon | Label | Task |
|---|---|---|---|---|
| Deploy history row | icon row action | `bug-report` | Investigate failure | new task, Deploy category |
| Build detail (build-fix) | destructive section button | `auto-fix-high` | Launch agent to investigate | new task, Build category |
| Report detail | primary button | `auto-fix-high` | Launch an agent to investigate | `investigate(reportId)`, then **View task** |
| Crash boundary | underlined text | `auto-fix-high` | Fix | `investigate()` |
| Config conflict | small icon | `auto-awesome` | Resolve this config conflict | new task, Config category |

Problems: different trigger, icon and wording on every surface. Deploy and build
mint a fresh task on every click, and the row never shows that one exists (only
reports dedupe, through a bespoke `_reports.task_id` column). And nothing makes
a NEW failure surface get the action: it exists only where someone remembered.

Goal:
1. one Investigate experience: same trigger, same label, dedupe → "View task";
2. surfaces get it by declaring it ONCE, next to the data, and the DataView renders it;
3. a check that finds failure-bearing collections with no investigator.

## Design

### 1. The subject → task link (generic, in tasks)

New `plugins/tasks/plugins/task-subject`: a side-table
`tasks_ext_subject (task_id PK, subject_kind text, subject_id text)` built with
`infra/entity-extensions.defineExtension` (the same mechanism as
`tasks_ext_auto_start` / `tasks_ext_source_url`), with an index on
`(subject_kind, subject_id)`.

- `POST /api/tasks/launch` (`plugins/tasks/core/endpoints.ts` `LaunchTaskBodySchema`,
  handler `plugins/tasks/server/internal/handle-launch-task.ts`) gains an optional
  `subject: { kind, id }` on the `{ title, categoryId }` arm. The handler reuses the
  subject's live task when one exists (not `done` / `dropped`), else creates it and
  writes the link in the same transaction. Dedupe is decided on the server, so a
  double-click or two tabs cannot mint two tasks.
- Web: `useSubjectTask({ kind, id })` is a live point read that returns
  `loading | { taskId } | none`.
- A subject kind is a plain string owned by the caller (`build-run`, `deploy-run`,
  `job-run`, …). Tasks names none of them.

Reports keeps its own `_reports.task_id`: it predates this and the
reports-investigation automation batches several reports into one task, which is
a different relationship. Reports is migrated to the shared *UI* only (§2,
`link` mode).

### 2. `InvestigateAction` (primitive)

New `plugins/primitives/plugins/launch/plugins/investigate` (web). One component,
with a fixed icon (`bug-report`), label ("Investigate"), tooltip
("Launch an agent to investigate this failure"), popover copy and draft key:

```ts
type InvestigateActionProps = {
  /** What failed, for the popover copy: "this failed build". */
  noun: string;
  presentation: "row-action" | "button";   // icon button in a row, or labelled Button in a pane
} & (
  | { subject: { kind: string; id: string }; categoryId: string;
      brief: (userText: string) => string }                        // generic: task-subject dedupe
  | { link: { taskId: string | null };
      resolve: (userText: string) => Promise<{ taskId: string; prompt: string }> } // reports
);
```

- When it is linked, it renders **View task** (`appLinkProps(taskDetailRoute…)`,
  as in report-detail today) instead of the launch popover.
- While the link is loading, it renders the pending state, never the launch
  trigger (the "not-known-yet is a state" rule).
- It wraps `LaunchAgentPopover`. The `getRequest` returns
  `{ prompt, categoryId, subject }`, so `LaunchAgentRequest` gains the optional
  `subject`.
- The *gate* is not the primitive's job. Callers render it only for a failed
  record. §3 makes that declarative.

### 3. `Investigate.Register` — declared once per collection, rendered by DataView

The attachment point is the collection (or the union arm), mirroring
`FieldPresentation.Register({ owner })`:

```ts
Investigate.Register({
  owner: buildRunArm,                       // a liveCollection or liveArm handle
  failed: (row) => row.outcome === "failed",
  noun: "build",
  categoryId: BUILD_CATEGORY_ID,
  subject: (row) => ({ kind: "build-run", id: row.id }),
  brief: (row, userText) => …,              // facts + where to dig, the deploy brief's shape
});
```

To keep data-view from depending on launch/tasks:
- **data-view** gains a generic, collection-owned item-action seam,
  `CollectionItemAction.Register({ owner, component })`.
- `liveDataSource` carries its owner. A DataView whose source owner (or a union
  row's arm) has registrations renders them as item actions, merged with the
  consumer's own `itemActions`.
- **investigate** implements `Investigate.Register` as sugar over that seam. The
  component evaluates `failed(row)` and renders `InvestigateAction` with
  `presentation: "row-action"`.

Every DataView over that collection gets the action, so a new surface gets it
with zero code: the runs union, the deploy history and any future list.

### 4. The check: `investigate:failures-registered`

`plugins/primitives/plugins/launch/plugins/investigate/check/index.ts` follows the
`live:arms-registered` shape (`plugins/network/plugins/live/check/index.ts`:
`listCandidateSources`, `boundCalls`, `namesIn`, `importAliases`).

- **Signal.** A `liveCollection(` / `liveArm(` (and an entity-extension
  `exposes.fields`) declares a field option with `variant: "destructive"`,
  directly or through an imported `*_OPTIONS_META` constant resolved by name.
  The `destructive` tint already means "the one outcome someone must act on"
  (`RUN_OUTCOME_OPTIONS_META`).
- **Requirement.** The owning plugin's web code names that handle in an
  `Investigate.Register(` call.
- **Escape.** Where destructive is not a failure (events emission `unmatched`,
  deploy health `ok: false`), the plugin declares an exemption in its
  `exempt/index.ts` with `kind: "sanctioned"` and a reason. Never an allowlist
  inside the check.

Today's candidates, from the survey:
- `runs` (`RUN_OUTCOME_OPTIONS_META`), build arm (`BUILD_STATUS_OPTIONS_META`),
  release status;
- events runs (`RUN_OUTCOME_META`), claude-cli calls (`error`);
- sonata transcription (`failed`);
- events emissions and deploy health, which are likely exemptions.

**Limit (stated, not hidden).** Failures rendered outside a collection (banners,
chips, ad-hoc error panels) are not caught. That gap is accepted for now. The
reports backstop is the follow-up (see below).

### 5. Adopt on the runs union and background jobs

- **runs**: each arm (`build`, `deploy`, `backup`, `release` `runs-arm/web`)
  registers `Investigate.Register({ owner: <arm> })`. The brief is built from
  `arm.read(run)` plus the base `message`. `RunsDataView`
  (`plugins/runs/web/components/runs-data-view.tsx`) needs no change beyond §3's
  merge.
- **Background jobs** do NOT become a runs arm. `job_runs` is a churning
  ~1,800-row ring (20 per job), which would flood the union with low-value rows.
  Instead:
  - `BackgroundRunSchema` (`plugins/infra/plugins/background/plugins/catalog/core/internal/entry.ts`)
    gains the run's `id`, which is the `job_runs.id` (`job_name:seq`) for job
    providers.
  - `recent-runs.tsx` renders `InvestigateAction` (`subject: { kind: "job-run", id }`)
    on `outcome === "failed"`, since its DataView is over a `liveValue`, not a
    collection.
  - The brief carries the job name, attempt, error, input and pointers: the
    `job_runs` row via `query_db`, the `[jobs] <name> failed` report, and the logs.
  - The `jobRuns` collection (`plugins/infra/plugins/jobs/core/resources.ts`)
    also registers, so any future DataView over it inherits the action.

### 6. Migrate the hand-rolled ones

| Today | Becomes |
|---|---|
| `deploy-history/plugins/investigate-failure` row action | `Investigate.Register({ owner: deployRunArm, … })`; the plugin keeps only its brief |
| `build/plugins/build-fix` section button | `InvestigateAction presentation="button"`, `subject: build-run` |
| `debug/plugins/reports` report-detail | `InvestigateAction` in `link` mode (`report.taskId`, `investigate()`) |
| `reports/plugins/launch-fix` crash "Fix" | `InvestigateAction` in `link` mode, `presentation="button"` |

Config conflict and the JSONL "add a renderer" button are not failures of a
record. They stay as they are.

## Out of scope / follow-ups

- Reports backstop: store the report id on failed records (a job run's
  `reportServerError` is fire-and-forget today, so the id is not captured). The
  generic error `Placeholder` could then offer Investigate through the report.
  This covers failures outside collections.
- Remaining surfaces with no collection: mail sync banner, worktree-cleanup row
  errors, health-report failed rows, failed attempt chips. Adopt
  `InvestigateAction` per surface once the primitive exists.

## Files

- New: `plugins/tasks/plugins/task-subject/{core,server,web}`;
  `plugins/primitives/plugins/launch/plugins/investigate/{web,check,exempt?}`.
- Edit:
  - `plugins/tasks/core/endpoints.ts`, `plugins/tasks/server/internal/handle-launch-task.ts`;
  - `plugins/primitives/plugins/launch/web/components/launch-agent-popover.tsx` (`subject` on the request);
  - data-view: the `CollectionItemAction` seam and owner on `liveDataSource`;
  - the four `runs-arm/web/index.ts`;
  - the background catalog `entry.ts`, `recent-runs.tsx` and its providers;
  - the four migrated sites in §6.

## Verification

- `./singularity test` on task-subject: launch twice with the same subject gives
  one task; a `dropped` task gives a new one.
- Check unit tests in the style of `check/index.test.ts`: a destructive option
  with no registration fails, and an exempted one passes.
- `./singularity check investigate:failures-registered` on the repo is green
  after §5–§6 plus the exemptions.
- `./singularity build`, then `screenshot.ts`:
  - `--path /debug/background/activity/job/backup.run.supervised --click "Investigate"`:
    the popover opens; launch it, and the row shows View task.
  - Runs list: a failed build row shows the same action.
  - Deploy history and build detail look identical to it.
