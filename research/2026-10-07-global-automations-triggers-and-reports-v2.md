# Automations v2 (rev 2): triggers, report scope, prompt as config

Supersedes the proposal section of `2026-10-07-global-automations-triggers-and-reports.md`.
The context and the exploration findings are the same as in that doc.

## User answers (2026-10-07)

- **Frequency.**
  - Every automation can run **by time** (a cron, "every X days", …) or **by event**.
  - For reports, "by event" means "when a report is filed".
  - It must not flood agents when many reports land at once, because they are
    likely the same issue.
- **Scope of which reports.** The user is unsure what the best UI is, so the
  prototype proposes one.
- **Agent scope.** The agent **fixes the cause**. It may push **only
  non-controversial changes**.
- **Controls.** Use best UX practice: presets plus a custom fallback.
- **Prompt.** It is a **config field written in the JSON**. It lives in git as
  the default, and the user can override it.

## Design

### 1. One trigger model for all automations

Each automation offers the user a choice of trigger. The automation declares which
kinds it supports.

| Trigger | UI | Runtime |
|---|---|---|
| **Schedule** | Presets: Every hour · Every day at `hh:mm` · Every `N` days at `hh:mm` · Every week on `day` at `hh:mm` · Custom cron | The cadence is derived to a cron, and the automation's job cron is **re-installed live when its config changes**, with no restart. This needs a jobs plugin change; see Risks. |
| **On event** | "When a report is filed", plus **Wait for things to settle: `10 min`** | The event enqueues the automation's job with a **debounce key**. A burst of events becomes ONE run, `settle` minutes after the last event. The run is capped at `settle × 6`, so a steady drip still runs. |

**Flood protection by construction:**

- **Debounce.** Events wait for things to settle, so a burst of 50 reports in 2
  minutes produces **one** run.
- **One open task per automation.** This is v1's dedupe, kept as-is.
  - While the investigation agent is working, newly qualifying reports are not
    filed.
  - The next run picks them up as long as they are still uninvestigated.
  - Most often the fix lands and they stop recurring.
- **The run files ONE task per batch.** The batch holds every qualifying report
  that has not yet been investigated, grouped by kind in the prompt.
  - The agent is told the reports may share one root cause.
  - Each report's `taskId` is linked to the batch task, so Debug → Reports shows
    "View task" on every report in it.
- **The existing fan-out ceiling.** The reports engine already collapses a storm
  of new fingerprints into one `report-storm` rollup before anything is emitted.

A schedule-triggered Report investigations run does the same batch: "every day,
investigate whatever qualified". The only difference between the two triggers is
*when* `detect` runs.

Dependency upgrades supports **Schedule** only. Its default is weekly, Monday
06:00, which is today's value.

### 2. Which reports: the scope UI

The proposal, built as the default prototype variant:

- **Severity** is a segmented control: `Errors` · `Errors & warnings` · `Everything`.
  The default is Errors.
- **Recurring** is a stepper: "occurred at least `N` times". The default is 3.
  - N = 1 means every report.
  - This is how "only real problems" is expressed without the user having to
    understand fingerprints.
- **Kinds** are the existing Sources card, listing report kinds grouped by
  severity.
  - Each kind is checked when its severity is in scope. Unchecking one excludes
    it, for example a noisy kind.
- **A live match count** sits under the rows: "**4 reports** match right now,
  across 2 kinds" · *Show them*.
  - *Show them* opens Debug → Reports, pre-filtered.
  - This gives immediate feedback on what the scope means, which is the main UX
    point.

The alternative variant (option `scope: simple | filter`) is a filter from the
Reports DataView: the same filter language (`network/live/filter`), so any column
can be used. It is more powerful, but less guided. The user picks one on the
prototype.

### 3. Agent scope and push

The **Push** setting becomes a three-way `Seg` on every automation. It replaces
the autoPush bool.

- `Never` means build, then raise a flag for review.
- `If uncontroversial` means push only when every one of these holds:
  - The change is small and local.
  - It changes no behaviour or API a person relies on.
  - It needs no design choice.
  - Checks pass.

  Otherwise the agent stops and raises a flag explaining what needs a decision.
- `When checks pass` is today's autoPush on.

| Automation | Push default |
|---|---|
| Reports | `If uncontroversial` |
| Deps | `When checks pass` (today's behaviour) |

The policy is injected into the prompt as `{{pushPolicy}}`. Each policy's
paragraph is code-owned text, so a custom prompt still follows the switch.

The default Reports prompt asks the agent to:

1. Read the debug skill.
2. Find the root cause shared by the batched reports.
3. Fix it in the worktree.
4. Build, and confirm the reports stop.
5. Apply `{{pushPolicy}}`.
6. If no fix is possible, write up the root cause and raise a flag.

### 4. Prompt (and every setting) as config in git

Today `automationsConfig` is one list where only *changed* automations have an item,
so the defaults never reach the JSON. To put the prompt in git, change this:

- **One config document per automation:** `defineAutomationConfig(id, { trigger,
  push, model, prompt, …automation-specific fields })`, from `automations/core`.
  - The build then writes its defaults to
    `config/tasks/automations/<id>.origin.jsonc` **in git**. Hand-edited repo
    defaults go in `<id>.jsonc`, through config_v2's normal three layers.
  - The user's edits from the pane land in `~/.singularity/state/config/`.
- **The prompt is a multi-line text field** in that document, with
  `{{variable}}` placeholders.
  - The automation declares its variables, which the pane shows as chips with
    descriptions.
  - Saving a template that names an unknown variable is rejected with a field
    error.
  - A template that misses a *required* variable (`{{reports}}`) gets a warning.
- **The pane's Prompt card:**
  - It shows the effective template, with a "Customized" badge and *Reset to
    default* when the user's layer overrides it.
  - It has a *Preview* that renders the last filing's variables.
- **Settings → Config** shows the same documents with no extra work.
- **Migration:** the existing `settings` list items, and `depsUpdatesConfig.detectCron`,
  are read once into the new documents and then deleted.

### 5. Report investigations automation

- It is declared in `tasks/reports-investigation`, which owns the Reports
  category and the sink.
  - Supported triggers: Event (default) and Schedule.
  - It is **disabled by default**.
- **Event:** `recordReport` emits it only for an admitted `recorded` result. That
  is after duress and fan-out. `report-storm` and kinds whose severity is out of
  scope are filtered inside `detect`.
- **detect:**
  1. Select reports with `task_id IS NULL`, or whose linked task was dropped and
     which recurred since.
  2. Keep those within scope (severity, count ≥ N, kind included).
  3. If there are none, return null.
  4. Otherwise cap the batch at 20 reports, oldest first. The rest wait for the
     next run.
  5. Render each report with its kind's `renderTask`.
- **Filing:**
  - It uses the generic `fileAutomationTask` with per-report `sourceKeys`.
  - It then links every report's `taskId` through a new `linkReportsToTask` on
    the reports server barrel.
  - Pressing Investigate by hand stays as it is.

## Phases

1. **Prototype** (`proto-1791322234-nhur`, `registry` direction):
   - **Trigger row.** A `Seg` choosing Schedule or On event, with the presets for
     Schedule and the settle field for On event.
   - **Push** is a three-way `Seg`.
   - **The Reports detail:**
     - Its Scope rows (severity, recurrence, live match count).
     - Its kinds as sources.
     - Off by default.
   - **A Prompt card:**
     - The template with variable chips, Edit, Customized badge, Reset and Preview.
     - A note on where it lives: "Default from `config/…/report-investigations.origin.jsonc`".
   - **An option `scope: simple | filter`** for the scope UI.
   - Then review it with the user.
2. **Automations core:**
   - The per-automation config factory and the trigger union.
   - Event debounce plus the max-wait.
   - Live cron re-install in `infra/jobs`.
   - The three-way push policy and template rendering.
   - Migration.
   - Pane: Trigger, Push and Prompt sections, rendered generically from the
     catalog. The pane never names an automation.
3. **Deps upgrades** moves onto it: cadence config, and its prompt converted to a
   template.
4. **Report investigations:**
   - The event from `recordReport`.
   - Kind sources, the scope fields and `detect`.
   - The batch filing with report linking.

## Risks / to verify in phase 2

- **Live cron re-install.** Graphile's cron is installed once after `onAllReady`.
  - Option A: re-run the crontab install for one item on `watchConfig`.
  - Option B: the automation job self-schedules its next run with `runAt` (the
    next cron instant) on every run and on config change, with no graphile cron
    item.

  B is simpler and live by construction. **Leaning B.**
- **The debounce primitive.** Check whether jobs `dedup` supports a debounce
  (replace `runAt` on re-enqueue with the same key). Graphile's `job_key` with
  `job_key_mode: "replace"` does exactly this.
- **Generic config lookup on web.** The pane must read N automation documents
  without naming them. The catalog carries each automation's config descriptor
  id, and the web side resolves it through the config_v2 registry. Verify that the
  registry supports reading by id.

## Verification

- **Unit tests:**
  - Cadence to cron/next-run.
  - Template rendering, including unknown-variable rejection.
  - Report scope selection and batching.
  - Debounce: N events produce 1 job.
  - The migration.
- **Deploy:** run `./equin build`, then:
  - Change the deps cadence and check that the next run moves with no restart.
  - Override the reports prompt and check that `~/.singularity/state/config/…`
    holds the override and the origin `.jsonc` is unchanged.
- **Report investigations:**
  - Enable it with Everything, N = 1 and a 1-minute settle.
  - Fire 10 test reports.
  - Check for exactly **one** task, all 10 rows linked (`query_db`), and the
    agent launched.
  - Fire more reports while that task is open and check that nothing is filed
    until it closes.
- **E2E:** a script in `tasks/automations/e2e/` for the Trigger, Push and Prompt
  controls.

## Decisions (settled on the prototype, 2026-10-07)

- Scope UI: **simple** (severity Seg, "at least N times" stepper, per-kind checkboxes grouped by severity, live match count + Show in Reports).
- Event settle: 10 min default, max-wait 6× settle; one task per batch; one open task per automation.
- Report investigations defaults: off, Errors only, count ≥ 3, `report-storm` excluded, Opus, push = If uncontroversial.
- No "Agents at once" control (one open task per automation).
- Prompt: full editable template with declared `{{variables}}`, stored as a config field (origin.jsonc in git, user override in state).
