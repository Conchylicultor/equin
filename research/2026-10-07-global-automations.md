# Automations — monitor and control agents the system launches on its own

Prototype: `proto-1791322234-nhur` (registry direction). Deferred: the "Propose" policy, which needs a surface the user actually watches. That surface is the queue generalisation, `task-1791329893008-fup7tm`.

## Context

The system can file a task and start an agent with nobody clicking anything. Today exactly one thing does this:

- **Dependency upgrades.** `deps.detect-outdated` (`plugins/infra/plugins/deps/plugins/updates/server/internal/detect-job.ts`) runs on a cron (weekly by default). It files ONE batched task and calls `armTaskAutoStart`. The agent pushes by itself when the verdict is `upgraded`.

Report investigations, upstream merges and failed-deploy triage all start with a person clicking, so they are not automations yet.

There is no place to watch or steer this:

- The tasks are mixed into the task list, under the Dependencies category.
- The job shows up only in Debug → Background activity.
- Where a task came from is recorded only as an author string (`deps.upgrade` / `deps.<updater>`). Finding the open task scans every Dependencies task (`openUpgradeTaskId`).
- The model is hardcoded (`DEFAULT_MODEL_CHOICE`). The only off switch is emptying the cron, and that needs a restart.
- Pushing without asking is hardcoded in the prompt text (`upgradeTaskDescription`).

Goal:
- A generic **Automations** registry, plus an **Automations** pane in the agent manager.
- Per-automation controls: **Enabled** (Off / Auto-launch), **Push when checks pass**, **Model**, and **which sources take part**.
- Where a task came from, stored durably.
- A bell notification when an automated task needs the person.

Out of scope for v1, with reasons:
- **Propose policy**: deferred, see above.
- **Concurrency cap**: an automation keeps at most one open task, so a cap has nothing to limit yet. Add it as a launch gate when a second automation can file in parallel.
- **Spend**: token usage lives only in the transcript JSONL. No cost is persisted anywhere.

## Design

### 1. New plugin `plugins/tasks/plugins/automations`

It lives under `tasks/` because an automation is, by definition, something that files tasks.

**core/** (public)
- `AutomationEntrySchema` = `{ id, label, icon, description, categoryId, trigger: { kind: "schedule", jobName, cronText } | { kind: "event", eventName }, sources: {id,label}[], defaults: AutomationSettings }`.
- `AutomationSettings` = `{ enabled: boolean, autoPush: boolean, model: StoredModelChoice, excludedSources: string[] }`.
- `automationsCatalog = liveValue("automations.catalog", { schema: z.array(AutomationEntrySchema) })`. The registry is declared in code, so this is a small computed value, the same shape as `background.catalog`.
- `automationTasks = liveCollection("automations.tasks", { row: { taskId, automationId, sourceKeys, filedAt }, id: "taskId", filterable: { automationId: liveText() }, default: { orderBy: [["filedAt","desc"]], limit: 50 }, maxLimit: 200 })`.
- Routes: `automationsRoute` (`segment: "automations"`) and `automationDetailRoute` (`a/:automationId`).

**shared/**
- `taskOriginShape = defineExtensionShape({ key: "taskId", fields: { automationId, sourceKeys (json string[]), filedAt } })`.
- `automationsConfig = defineConfig({ fields: { settings: listField({ itemFields: { automationId, enabled, autoPush, model, excludedSources } }) } })`. A missing item means "use the automation's declared defaults", so adding an automation never changes saved config. Registered on both sides (`ConfigV2.Register` + `ConfigV2.WebRegister`, as `registrations-paired` requires).

**server/**
- `tasksOrigin = defineExtension(_tasks, "origin", taskOriginShape)` creates `tasks_ext_origin`. A row means the task was filed by an automation. It replaces author-string matching.
- `defineAutomation(spec)` is modelled on `defineBackgroundKind` / `defineRunKind`: a module-level registry, and `register()` throws on a duplicate id. **The automation owns its job**, so a disabled automation cannot file anything:
  ```ts
  defineAutomation({
    id: "deps-upgrades", label, icon, description, categoryId: DEPS_CATEGORY_ID,
    schedule: { cron: () => getConfig(depsUpdatesConfig).detectCron.trim() || null },
    sources: () => declaredUpdaters().map(u => ({ id: u.id, label: u.id })),
    defaults: { enabled: true, autoPush: true, model: DEFAULT_MODEL_CHOICE, excludedSources: [] },
    // Runs only when enabled; gets only the included sources and the resolved settings.
    detect: async ({ sources, settings }) => null | { title, description, sourceKeys },
  })
  ```
  `defineAutomation` builds the `defineJob` itself (`automation.<id>`, singleton, `hold: "minutes"`). Its `run` does this:
  1. Resolve the settings: the config item over the defaults. If disabled, log and return.
  2. **Dedupe**: if an origin row exists for this automation whose task is not `done`/`dropped`, return. This is one indexed query on `tasks_ext_origin` joined to the task-status view.
  3. Call `detect(...)`. On `null`, return.
  4. In one transaction: `createTask({ author: "automation:<id>", titleAuto: false, ... })`, `setTaskCategory`, insert the origin row.
  5. Call `armTaskAutoStart({ taskId, model: settings.model, cause: "automation:<id>" })`. `cause` lands in `conversations.spawnedBy` as before.
  It returns the job handle for the plugin's `register: [...]`.
- `serveValue(automationsCatalog, { source: "external", loader })` lists the registry.
- `serveCollection(automationTasks, { from: tasksOrigin.table })`.
- **Attention notification**: a trigger on `tasks-core.taskStatusChanged`. When a task that has an origin row moves to `need_action` / `attempted` / `held`, call `recordNotification({ variant: "warning", title, linkTo: automationDetailRoute.link(agentManagerApp, { automationId }), dedupeKey: "automation-task:<taskId>" })`. This replaces "look at the task list", which the user never does.

**web/**
- `Shell.Sidebar({ id: "automations", title: "Automations", icon: symbol("smart_toy"), opens: opensPane(automationsPane, {}) })`, with `app: agentManagerApp`.
- **List pane**: a `DataView` (`views={["list"]}`, `defineDataView("tasks.automations")`) over `useLive(automationsCatalog)`. Each row shows the trigger, the enabled state and an open-task count. Activating a row pushes the detail pane. Precedent: `infra/plugins/background/plugins/catalog/web/panes.tsx` + `background-view.tsx`.
- **Detail pane** (`useResolve` over the catalog entry). Sections, as in the prototype:
  - Header: description, a **Run now** button (reuses `POST /api/background/run-now` for the automation's job), and the next run, read from the job's entry in `background.catalog`.
  - **Behavior**: the Enabled switch, the Push-when-checks-pass switch and the Model select. All of them write the item for this automation into `automationsConfig.settings`.
  - **Sources**: an include checkbox per source, which writes `excludedSources`. Hidden when the automation declares no sources.
  - **History**: a `DataView` over `useLive(automationTasks, { where: { automationId } })`, each row joined to its task (title and status) through tasks-core's existing per-task read. Status is drawn with `tasks/task-status`. Activating a row opens the task.
- `Tasks.Fields({ id: "origin", component: OriginField })` adds an "Automation" enum field (badge + filter) to every task DataView. Precedent: `tasks/plugins/task-track/web/components/track-field.tsx`.

### 2. Move deps upgrades onto it

Changes in `plugins/infra/plugins/deps/plugins/updates`:
- `detect-job.ts`:
  - Delete `detectOutdatedDepsJob`, `fileUpgradeTask`, `openUpgradeTaskId` and `AUTHOR`.
  - Replace them with `depsUpgradesAutomation = defineAutomation({...})`. Its `detect` runs each **included** updater and returns the batch, or `null`.
  - Keep `UpdaterDeclare` / `declaredUpdaters` (the CLI uses them).
- `core/internal/upgrade-prompt.ts`:
  - `upgradeTaskDescription(batch, { autoPush })`.
  - When `autoPush` is false, drop the "You are authorized to push…" paragraph and say: stop after `build-status.json` is `ok` and raise a flag for review.
  - No guard is needed: the repo-wide default ("never push unless told") already applies once the authorization is absent.
- `detectCron` stays in `depsUpdatesConfig`. It is how this automation schedules itself, and the automation shows it as its trigger.
- **Transition**:
  - A task filed before this change has no origin row, so the dedupe would not see it.
  - `defineAutomation` therefore takes an optional `adoptLegacy: () => Promise<string[]>` (task ids). Its boot warm-up writes the missing origin rows once, idempotently.
  - Deps implements it with the old author/category match (`author LIKE 'deps.%'` in the `dependencies` category).
  - Delete it in a later release.
- The job name changes from `deps.detect-outdated` to `automation.deps-upgrades`. Its earlier run history stays under the old name in Background activity.
- Update the docs that name the old job: `deps/plugins/updates` CLAUDE.md, and the "Dependencies-category upgrade task" sentence in root `CLAUDE.md`, which still holds.

## Critical files

- New: `plugins/tasks/plugins/automations/{core,shared,server,web}/…`
- `plugins/infra/plugins/deps/plugins/updates/server/internal/detect-job.ts`, `server/index.ts`, `core/internal/upgrade-prompt.ts`
- Reused, not modified:
  - `tasks/server` `armTaskAutoStart`
  - `tasks-core` `createTask` / `taskStatusChanged`
  - `task-category` `setTaskCategory`
  - `entity-extensions` `defineExtension`
  - `shell/plugins/notifications/server` `recordNotification`
  - `background/catalog` run-now endpoint + catalog value
  - `network/live` `liveValue` / `liveCollection` / `serveValue` / `serveCollection`
  - `config_v2` `listField`

## Verification

1. `./equin build`. The migration for `tasks_ext_origin` is generated, and the checks pass (boundaries, `registrations-paired`, plugin docs).
2. `./equin test plugins/tasks/plugins/automations`: unit tests for:
   - settings resolution (config item over the defaults)
   - the dedupe query
   - `upgradeTaskDescription` with and without `autoPush`
3. On the deploy:
   - Open Agent manager → Automations. Dependency upgrades is listed with its weekly trigger and next run.
   - Toggle Enabled off, then Run now. The run log shows "disabled" and no task is filed.
   - Turn it back on, exclude `uv`, and Run now. The filed task covers only the remaining updaters. It has an origin row (`query_db` on `tasks_ext_origin`), the chosen model on the conversation, and an "Automation" badge in the task list.
   - With Push off, the task description contains no push authorization.
   - Hold the task. A bell notification links to the automation's detail pane.
4. Screenshot both panes with `e2e-harness/e2e/screenshot.ts --path /agents/automations`.
