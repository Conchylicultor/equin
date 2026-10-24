# Automations v2: trigger control, editable prompts, Report investigations

Follow-up to `research/2026-10-07-global-automations.md` (plugin `tasks/automations`,
prototype `proto-1791322234-nhur`).

## Context

The Automations registry (v1) has three gaps:

1. **Report investigations is not an automation.** To investigate a report today,
   the user presses Investigate in Debug → Reports and then launches the task. The
   user wants it to run on its own, **off by default**.
2. **The user cannot choose how often an automation fires.** Dependency upgrades
   has a cron textField (`depsUpdatesConfig.detectCron`) in Settings → Config, and
   it is read once at boot. An event-driven automation has no control at all. The
   user wants one frequency control per automation, in the Automations pane.
3. **The prompt is invisible and fixed.** `upgradeTaskDescription` and each report
   kind's `renderTask` build the agent's prompt in code. The user wants to see the
   template and edit it.

Process (from the task): **update the prototype first, discuss it with the user
to settle the open questions below, then implement.** Implementation phases 2–4
are a proposal until that discussion happens.

## What exists (from exploration)

- **`defineAutomation`** (`plugins/tasks/plugins/automations/server/internal/define.ts`)
  owns `defineJob({ name: "automation.<id>", schedule: { cron } })`.
  - The cron is resolved **once at boot**: `resolveJobCron` in the jobs registry,
    installed after `onAllReady`.
  - The dedupe is **one open task per automation** (`openAutomationTaskId`,
    `origin.ts`).
  - The settings are `{enabled, autoPush, model, excludedSources}` in
    `automationsConfig` (`shared/config.ts`).
  - The catalog trigger is `{kind:"schedule", jobName, cron}` only.
- **Reports** (`plugins/reports`):
  - Reports are deduped per (fingerprint, worktree), with a `count`.
  - There is **no severity column**. Severity is the kind's `meta.variant`.
  - `taskId` is the only link to an investigation.
  - The fan-out gate already collapses floods into one `report-storm` rollup:
    20 new fingerprints per kind per minute.
  - **No event is emitted on record.**
- **Investigate today:** `investigateReport(reportId)` (`reports/server/internal/investigate.ts`).
  - It is mutexed per report.
  - It renders the kind's `renderTask(row)`, appends a debug-skill hint, and emits
    `reportInvestigationSink`.
  - The handler in `tasks/reports-investigation` reuses `row.taskId` unless that
    task is dropped. It creates the task but does not launch it.
- **History.** In June, reports auto-filed a task on every record. That flooded the
  task list, so it was removed (`research/2026-06-23-reports-decouple-from-tasks.md`).
  **This automation must not bring that back.** Being off by default, a threshold,
  and a rate cap are what prevent it.

## Proposed design

### A. One generic trigger model: *when it checks* plus *what it takes to file*

Every automation already has the same shape: something wakes it up, `detect` decides
whether there is work, and it files a task. Frequency splits into two user controls,
and both kinds of automation share them:

```ts
type Trigger =
  | { kind: "schedule"; cadence: Cadence }         // deps upgrades
  | { kind: "event"; event: string };              // reports: "report recorded"

type Cadence =                                      // the user picks one; we derive the cron
  | { every: "hour" }
  | { every: "day"; at: "06:00" }
  | { every: "week"; on: "mon"; at: "06:00" }
  | { every: "cron"; cron: string };               // advanced escape hatch

interface Throttle {                                // shared by both kinds
  maxOpen: number;          // agents running/open at once (v1's "one open task" becomes maxOpen: 1)
  maxPerDay: number | null; // storm cap: tasks filed per rolling 24 h
}
```

- **Schedule automations** (deps upgrades): the user edits the cadence in the pane.
  `detectCron` leaves `depsUpdatesConfig` and moves into `automationsConfig` as a
  `cadence` setting. This needs **live re-scheduling**: the jobs plugin re-installs
  an automation's cron item when its config changes, with no restart.
  - To verify in implementation: can graphile's cron be re-installed in-process?
  - If it cannot, the fallback is to restart the worker's cron runner. We never
    poll.
- **Event automations** (reports): no cron. The automation declares its event, and
  the event wakes its job with the event payload (e.g. `{ reportId }`). Its own
  per-automation *filters* decide whether that occurrence files a task.
  - For reports, "every XX times" means: **a report recurs N times** (`count >= N`).
  - It is a filter on the event, not a cadence.
  - A schedule automation has no N. Its cadence is "how often to check".
- **The throttle** is the one storm control that both kinds share:
  - `maxOpen` generalises v1's one-open-task dedupe. With per-key dedupe (below),
    reports can have several tasks open, each for a different report.
  - `maxPerDay` caps the filing rate.
  - When the throttle blocks a filing, the occurrence is **deferred, not
    dropped**. The report keeps its `taskId = null` and the next wake-up reconsiders
    it, so it is still filed later once the throttle allows.
- **Dedupe key:** the spec declares `dedupe: "automation" | "source-key"`.
  - Deps upgrades keeps `"automation"`: one batched task.
  - Reports uses `"source-key"`: one task per report id. The key already exists
    as `tasks_ext_origin.sourceKeys`.

### B. Editable prompt template

- Each spec declares `prompt: { template: string; variables: Record<name, description> }`.
  It also declares a `render(ctx) → Record<name, string>` per filing.
  - Deps: `{{outdated}}`, `{{landStep}}`.
  - Reports: `{{report}}`, which is the kind's `renderTask` body. Plus `{{title}}`,
    `{{count}}`, `{{kind}}` and `{{debugHint}}`.
- `automationsConfig` gains an optional `promptOverride`. Empty means the default
  is used.
  - The pane shows a **Prompt** card with the template, the variable chips, an
    Edit / Reset to default action, and a live preview rendered from the last filing.
  - An unknown `{{var}}` is a validation error at save time, not a silent blank.
- The push paragraph stays a variable driven by `autoPush`, so toggling "Push when
  checks pass" still works with a custom template.

### C. Report investigations automation

- Declared in `tasks/reports-investigation`, which already owns the Reports
  category and the sink handler. It uses `defineAutomation` with
  `trigger: {kind:"event", event:"reports.recorded"}`.
- **Event.** `recordReport` emits it after `writeReport` returns `recorded`.
  - It emits only after fan-out and storm admission, so a collapsed storm never
    wakes it.
  - The `report-storm` kind is excluded by default.
  - The event is a `defineTriggerEvent` (main only) or an in-process hook. To decide
    in implementation.
- **Sources = report kinds** (from the `ReportKind` registry). The existing Sources
  card becomes per-kind include/exclude, and per-kind override of N comes for free.
- **Filing** reuses `investigateReport(reportId)`. That gives the same
  `renderTask`, the same report→task link, and the same "reuse an open task" guard,
  then arms auto-start with the automation's model. **Never re-file** for a report
  whose task is open or done. A new task is filed only if the task was dropped and
  the report has recurred since. To confirm.
- **Defaults:**

  | Setting | Default |
  |---|---|
  | `enabled` | **false** |
  | Severity | `error` kinds only |
  | Recurrence threshold N | 3 |
  | `maxOpen` | 2 |
  | `maxPerDay` | 5 |
  | `autoPush` | false |
  | Model | default |

### Agent scope (proposed, to confirm)

- Root-cause **and** fix in its worktree, then build.
- It does not push unless "Push when checks pass" is on, which is off by default.
- If it finds no fix, it writes up the root cause and raises a flag.
- One task per report, not per batch. A per-batch task is the alternative: it
  folds all qualifying reports since the last run into one task, like deps.

## Open questions to settle on the prototype

1. **Which reports trigger an agent:**
   - Every new report.
   - Only once a report recurs N times.
   - By severity.
   - By kind.
   - Some combination of these.

   Proposed: severity ≥ error AND count ≥ N, with per-kind opt-out.
2. **What "every XX times" means:** recurrence count per report (proposed), or
   "one investigation per XX reports overall".
3. **Agent scope:**
   - Root-cause only, or fix?
   - May it push?
   - One task per report, or one per batch?
4. **Storm behaviour:**
   - Are the throttle's `maxOpen` and `maxPerDay` the right two knobs?
   - Should a throttled report be deferred (proposed) or skipped?
5. **Cadence control:** presets (hourly / daily at / weekly on-at) plus an advanced
   cron (proposed), or a raw cron only.
6. **Prompt editing:**
   - A full template override with variables (proposed), or only an "extra
     instructions" text appended to a fixed prompt?
   - The second is simpler and survives prompt changes in code. This is worth
     weighing.

## Phases

**Phase 1 — Prototype** (`~/.singularity/apps/prototypes/proto-1791322234-nhur/index.html`, `registry` direction):

- Turn the "Report investigations" mock into an event trigger, `enabled: false`.
- Replace the static Trigger stat with structured trigger data.
- Behavior card, new rows:
  - **When it runs**:
    - Schedule: a `Seg` of Hourly / Daily / Weekly, plus a time and weekday select,
      plus Custom cron.
    - Event: the event name, plus **Investigate when**: a severity `Seg` and an
      "after N occurrences" `Stepper`.
  - **Limits**: agents at once (the existing Stepper becomes `maxOpen`), plus at
    most N tasks per day.
- New **Prompt** card:
  - It shows the template in a monospace block, with the variable chips.
  - Edit turns it into a textarea, with Reset to default.
  - It has a preview toggle that renders the last filing.
- Add an option `prompt: template | extra` to show both answers to Q6 side by side.
- The Sources card for reports lists the report kinds, with the severity tag and an
  optional per-kind N.
- Then discuss Q1–Q6 with the user. Write the answers into a `-v2` plan before
  coding.

**Phase 2 — Generic trigger + throttle + prompt in `tasks/automations`:**

- Spec:
  - Change the `AutomationSpec` trigger field to the `Trigger` union.
  - Add the `dedupe`, `throttle` defaults and `prompt` fields.
- Config:
  - `automationsConfig` items gain `cadence`, `throttle`, `promptOverride` and
    per-automation filter settings. The filter settings are a JSON field whose
    zod schema the automation declares.
- Catalog:
  - `AutomationEntrySchema.trigger` is the union, with the resolved cron and next
    run for schedules.
  - The catalog also carries the prompt template and its variables.
- `runAutomation` gets per-key dedupe and the throttle check.
- Jobs: live cron re-install on a config change (`infra/jobs`, `resolveJobCron`
  plus `installScheduledCronItems` in `worker.ts`).
- Web (`web/components/automation-detail.tsx`): Cadence and Limits rows in
  Behavior, and a new Prompt section.

**Phase 3 — Deps upgrades on the new model:**

- Its default cadence is weekly, Monday 06:00, which matches today.
- Move `detectCron` into the cadence setting. Delete it from `depsUpdatesConfig`,
  with a one-time read of a saved value as the cadence's initial value.
- Convert `upgradeTaskDescription` into a template plus variables.
- Keep `upgrade-prompt.test.ts`, updated.

**Phase 4 — Report investigations:**

- Emit the event from `recordReport`.
- Add the `ReportKind` registry as sources.
- Declare the automation in `tasks/reports-investigation`, off by default.
- Filing goes through `investigateReport` plus auto-start arming.

## Critical files

- `plugins/tasks/plugins/automations/server/internal/{define,registry,origin,live}.ts`
- `plugins/tasks/plugins/automations/{shared/config.ts,shared/settings.ts,core/internal/entry.ts}`
- `plugins/tasks/plugins/automations/web/components/automation-detail.tsx`, `web/internal/use-automations.ts`
- `plugins/infra/plugins/jobs/server/internal/{registry,worker}.ts` (live cron)
- `plugins/infra/plugins/deps/plugins/updates/{server/internal/detect-job.ts,core/internal/upgrade-prompt.ts,shared/config.ts}`
- `plugins/reports/server/internal/{record-report,investigate}.ts`
- `plugins/tasks/plugins/reports-investigation/server/internal/register.ts`

## Verification

- **Unit tests:**
  - Cadence → cron derivation.
  - Template rendering, including rejection of an unknown variable.
  - Throttle and per-key dedupe in `runAutomation`.
  - The updated `upgrade-prompt.test.ts`.
  - Run them with `./equin test plugins/tasks/plugins/automations`.
- **Deploy:** run `./equin build`, then:
  - Change the deps cadence in the pane.
  - Check that Background activity shows the new next run with no restart.
  - Edit the prompt, use Run now, and check that the filed task's description
    uses the override.
- **Report investigations:**
  - Turn it on with N = 1 and severity = any.
  - Trigger a test report.
  - Check that one task is filed, linked on the report (`query_db` on
    `reports.task_id`), and launched.
  - Flood more reports than `maxPerDay` and check that the extras are deferred
    with no task.
  - Turn it off and check that nothing files.
- **E2E:** a script in `tasks/automations/e2e/` drives the Behavior and Prompt
  controls.
