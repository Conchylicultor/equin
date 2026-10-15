# automations

Things that start agents with nobody clicking anything. Two kinds:

- **file** (the default) — `detect` finds work; the automation files ONE task
  for it and launches its agent, and files nothing more while that task is
  open (dependency upgrades, report investigations).
- **launch** — `candidates` names EXISTING tasks, best first; the automation
  launches agents on the ones **a person approved** — never any other — at most
  `concurrency` at a time, the next one when a slot frees, and at most
  `maxLaunches` per turn-on, after which it turns itself off (the sidequest
  autopilot).

Design: `research/2026-10-07-global-automations.md`; triggers, prompt and
Report investigations: `research/2026-10-07-global-automations-triggers-and-reports-v2.md`;
the launch kind: `research/2026-10-10-tasks-sidequest-autopilot.md`; approval and
the total cap: `research/2026-10-11-tasks-sidequest-autopilot-v2.md`.

## Declaring one

```ts
// shared/config.ts of the plugin that knows what to watch (both runtimes)
export const depsUpgradesConfig = defineAutomationConfig("deps-upgrades", {
  enabled: true, push: "checks", trigger: "schedule",
  cadence: "week", weekday: "mon", at: "06:00",
  prompt: DEPS_UPGRADE_PROMPT, // `{{outdated}}` … `{{pushPolicy}}`
}, /* optional fields of its own */);

// server/internal/…
export const depsUpgradesAutomation = defineAutomation({
  id: "deps-upgrades", label: "Dependency upgrades", icon: symbol("upgrade"),
  description: "…", categoryId: DEPS_CATEGORY_ID,
  config: depsUpgradesConfig,
  triggers: { kinds: ["schedule"] },        // or { kinds: ["event", "schedule"], eventLabel }
  inProcess: "<why detect may hold a job slot for minutes>",
  sources: () => declaredUpdaters().map((u) => ({ id: u.id, label: u.id })),
  promptVariables: [{ name: "outdated", description: "…" }],
  detect: async ({ sources, settings, config, signal, partialFailure }) =>
    /* null, or */ ({ title, variables: { outdated }, sourceKeys, onFiled? }),
});
// server: contributions: [automationConfigRegistration(depsUpgradesConfig)], register: [depsUpgradesAutomation]
// web:    contributions: [...automationConfigContributions(depsUpgradesConfig)]
```

A launch-kind one declares its config with `defineLaunchAutomationConfig`
(the common fields plus `concurrency` and `maxLaunches`) and `kind: "launch"` with `candidates`
instead of `categoryId` / `detect` (it files nothing, so it stamps no
category):

```ts
export const autopilotConfig = defineLaunchAutomationConfig("sidequest-autopilot", {
  enabled: false, push: "safe", trigger: "event", settleMinutes: 2,
  concurrency: 2, prompt: AUTOPILOT_PROMPT,
}, { runUntil: textField({ … }) });

export const autopilot = defineAutomation({
  kind: "launch", id: "sidequest-autopilot", label, icon, description,
  config: autopilotConfig, triggers: { kinds: ["event"], eventLabel }, inProcess,
  promptVariables: [{ name: "title", … }, …],
  candidates: async ({ settings, config, signal }) =>
    tasks.map((t) => ({ taskId: t.id, variables: { title: t.title, … } })),
});
```

**Its config is one document per automation**, named by its id and stored under
this plugin's tree whichever plugin declares it:
`config/tasks/automations/<id>.origin.jsonc` is the committed default (the
prompt template included), the person's edits are their own override. Both
registrations are required (`config-v2:registrations-paired` catches a missing
half); the pane finds the document through `Automations.Config`. The common
fields are `enabled`, `push` (`never` | `safe` = only an uncontroversial change |
`checks`), `model` (one shared field object, so one `DynamicEnum.Options`),
`excludedSources`, `trigger` + the schedule (`cadence` hour/day/days/week/cron,
`at` local HH:MM, `everyDays`, `weekday`, `cron` UTC) + `settleMinutes`, and
`prompt`; a launch-kind config adds `concurrency` and `maxLaunches`.

**The automation owns its job** (`automation.<id>`, singleton, `serial` — one
run at a time, so two runs can never both find no open task or both count a
slot free — `hold: "minutes"`, main-only), so nothing can file or launch
around its settings.

- **Schedule.** The job's cron resolver reads the config (`automationCron`,
  `cadenceCron` converting the local time with the current UTC offset). A config
  change re-installs every schedule at once (`watchConfig` →
  `refreshJobSchedules`), no restart. Off, set to its event, or an invalid
  schedule ⇒ no cron (the catalog's `scheduleError` says why).
- **Event.** The declaring plugin calls the handle's `fire()` from the hot path
  that sees the event. While on and set to its event, it enqueues the singleton
  job with `runAt = min(now + settle, burstStart + 6 × settle)` — graphile's
  `replace` key mode moves the one pending row, so a burst is one run (re-queued
  at most every 30 s). Main only.
- **Wake** (launch kind, whatever its trigger). The registry runs it at once
  (`RegisteredAutomation.wake`) when its slots may have moved: a task it
  launched settles (`automations.task-status`) or is released
  (`releaseLaunchedTask`), its config changes (turning it on starts it), and at
  boot (what settled while the backend was down announced nothing). The
  trigger is then only for *new work appearing* — a launch-kind automation
  declares the event that says a candidate may have appeared (the autopilot:
  a task becoming `new`); a schedule would only be a coarse substitute for it.
  Gap, by design: a task that becomes a candidate WITHOUT that event (e.g. an
  existing task switched to the sidequest track) waits for the next wake.

### A file-kind run

1. Reads the config. Disabled ⇒ logs and stops.
2. Adopts `adoptLegacy`'s tasks (idempotent), then **dedupes**: a task this
   automation filed that is neither done nor dropped ⇒ stops. So an event
   storm while its agent works files nothing; the next run picks up what still
   qualifies.
3. Calls `detect` with only the INCLUDED sources, the settings and the whole
   config. `null` ⇒ stops. A source that fails calls `partialFailure(err)`.
4. Fills the prompt template with the filing's `variables` + `pushPolicy`
   (`PUSH_POLICY_TEXT`). A placeholder with no value throws — never a blank.
5. In ONE transaction: `createTask` (author `automation:<id>`), its category,
   its origin row (role `filed`). Then `onFiled(taskId)`, then
   `armTaskAutoStart` with the chosen model.

### A launch-kind run (the pump)

1. Reads the config. Disabled ⇒ logs and stops.
2. Counts its **occupied slots**: its origin rows with role `launched`,
   `releasedAt` null, whose task is not in `SLOT_SETTLED_STATUSES` (`done`,
   `dropped`, `attempted` — its agent went away without reporting, counted as
   finished and belled — and `held`, a person's own act; waiting on it would
   stall the automation), and what is left of its **batch**: `maxLaunches`
   minus its launches since the batch opened (`automation_launch_batches`: a
   batch opens when it is turned on, closes when it is turned off — synced by
   the config watcher and at boot). `free = min(concurrency − occupied,
   batch left)` (never below 0: lowering either stops nothing). Batch spent ⇒
   it writes `enabled: false` (its config, `systemOrigin`) and stops; none free
   ⇒ stops.
3. Calls `candidates` (best first), keeps ONLY the tasks a person approved for
   it, skips any task an automation already filed or launched (a task has ONE
   origin) or someone already armed, and takes the first `free`
   (`selectLaunches`). After launching, a spent batch turns it off the same way.
4. For each: fills the template with the candidate's `variables` +
   `pushPolicy`, writes its origin row (role `launched`; insert-or-nothing, so
   a race loses cleanly), then `armTaskAutoStart` with the model and the
   filled prompt — stored ON the marker, so whichever path claims it (the
   queue's `tasks.maybe-launch` or an inline launch) starts the agent with it.
   The existing launch gates (main only, not held/dropped/blocked, Claude Code
   ready, the model resolves) apply as for any armed task; a task waiting on
   them still holds its slot.

**Approval.** `tasks_ext_launch_decision` (one row per task: `automationId`,
`decision: approved | excluded`, `decidedAt`) is the approved set, written
ONLY by `decideLaunchEndpoint` (`POST /api/automations/:automationId/launch-decisions`,
`decision: null` clears) — the person's click. Nothing on the server approves
a task, and `candidates` cannot bypass the filter: an automation only ranks.
`excluded` is for the automation's own review UI (not proposed again); the pump
ignores it. Served as `launchDecisions` (`automations.launch-decisions.all`), the
whole ordered set (`all`, at most one row per task): a launch list joins it to
every task it shows, so it reads it entire and keeps its own automation's rows
(`useLive(launchDecisions, { select })`).

Dedupe ("one open task") is file-kind only. A launched task stays the person's
task: its category, title and description are untouched; the role says the
automation only started it.

**Releasing a slot.** `releaseLaunchedTask(taskId)` (server barrel) stamps the
launched row's `releasedAt` and wakes the automation that launched it — called
by whatever knows the agent is done with what it was launched for (the
outcome-report plugin, when the agent submits its report), so a conversation
left open for the person to read does not hold a slot. The registry never
imports such a plugin. No-op (`false`) for a task no automation launched.

Every run logs one line to the `automations` log channel.

## The pane

Behavior (Enabled, Model, At once for a launch kind, Push), Trigger (kind,
schedule presets / cron, or the settle wait), the `Automations.Section`
contributions for this automation (a render slot keyed by `automationId` —
e.g. Report investigations' Which reports, the autopilot's Run until), Sources,
Prompt (the template; "Customized" when the user layer supplies it, Reset to
default through config_v2's `resetConfigField`; a template naming an unknown
variable is not saved), History (filed and started tasks). A History row
expands (the list view's `detail` option; open rows live in the view's expand
map) into every `Automations.TaskDetail` contribution for its task — a render
slot whose component gets `{ taskId, automationId }` and renders nothing when it
has nothing to say (the outcome-report plugin contributes the agent's report).
This plugin names no contributor; they import it, never the reverse.

## Where a task came from

`tasks_ext_origin` (entity extension of tasks, `core/internal/resources.ts`):
`{ taskId, automationId, sourceKeys, filedAt, role, releasedAt }`. A row PROVES
an automation filed (`role: "filed"`) or launched (`"launched"`) the task; a
task with none was filed and started by a person or an agent acting for one.
Rows from before launches existed read `filed` (the column's DB default).
`automationOfTask(taskId)` (server barrel) answers which automation, for a
plugin that treats automated tasks differently (the outcome-report tool is
offered only to them). Read two ways from the one table:

- `automationTasks` (`automations.tasks`) — an automation's HISTORY: a window
  filterable by `automationId` (newest first), and point reads by task id.
- EXPOSED (`taskOriginShape.exposes`, served by
  `LiveColumns.Expose(tasksOrigin)`): `automationId` under the field id
  `origin` (`as` — what saved views name), in every list whose rows reach a
  task (the task list's Automation field), filtered, sorted and grouped there
  with no list code. A task with no row reads NULL — by hand, the "None"
  bucket. Its options are the live catalog's (`web/internal/presentation.ts`,
  `useOriginOptions`: each automation an info chip). A saved filter
  `origin = by-hand` (the old field's literal) is now `origin is empty`.

## Reads

- `automationsCatalog` (`automations.catalog`, external) — every registered
  automation with `kind`, `enabled`, its trigger (supported kinds, current
  kind, words, `jobName`, installed `cron`, `scheduleError`), sources, prompt
  variables, and by kind: `categoryId` + `openTaskId` (file), `concurrency` +
  `runningTaskIds` + `maxLaunches` + `launchedInBatch` + `approvedCount`
  (launch; the list shows "N running"). Re-pushed when an
  automation's config changes, it files, launches or releases a task, or one of
  its tasks changes status.
- `automationTasks`, `launchDecisions` — see above.
- `automationsRoute` / `automationDetailRoute` (`automation/:automationId`).

## The person's attention

A trigger on `tasks.statusChanged` (`automations.task-status`):

- a FILED task moving to `need_action` / `attempted` / `held` ⇒ a warning in the
  bell, linking to the automation's detail pane;
- a LAUNCHED task rings only on `attempted` while unreleased (its agent went
  away without reporting). Its agent leaves a report instead, whose own surface
  asks for the person: `need_action` is passed at every turn's end (a build
  wait included) and would be noise, `held` is the person's own act, and once
  released, closing its conversation is the person reading the report;
- a launched task reaching a settled status wakes its automation.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Automations in the agent manager: the Automations sidebar entry and list (a DataView over the catalog — trigger in words, next run, on/off, open task), the detail pane (Run now through Background activity; Behavior — enabled, model, push policy; Trigger — schedule presets or custom cron, or the event and its settle wait; the sections an automation contributes through Automations.Section; its sources; the Prompt template with Customized / Reset to default — PromptTemplateBlock, the same editor for any template field an automation declares; and the History of the tasks it filed or started — each row expandable into the Automations.TaskDetail contributions for its task), the presentation of the exposed `origin` Automation field in every list whose rows reach a task (its options the live catalog), and automationConfigContributions — how a declaring plugin registers its automation's config document (Automations.Config). Automations registry: defineAutomation declares something that files a task and launches its agent on its own (file kind) or launches agents on existing tasks a few at a time (launch kind: candidates, launched ONLY when a person approved them — the tasks_ext_launch_decision side-table, written by the decide-launch endpoint alone — concurrency slots held until a task settles or releaseLaunchedTask, and a maxLaunches batch per turn-on after which it turns itself off), and owns its job (automation.<id>) — its config document (defineAutomationConfig: enabled, push policy, model, excluded sources, trigger — a schedule re-installed live on change, or an event whose bursts settle into one run — and the prompt template), the one-open-task dedupe, the filled prompt, the filing (task + category + tasks_ext_origin row in one transaction) and the armed launch. Serves the automations.catalog value, the automations.tasks collection (the origin side-table, an automation's history) and the automations.launch-decisions.all set, exposes the filing automation to every list whose rows reach a task (the `origin` field), and notifies the bell when an automated task needs its person.
- Web:
  - Slots:
    - `Automations.Config`
    - `Automations.Section`
    - `Automations.TaskDetail`
    - `automations.actions`
    - `automation-detail.actions`
  - Slot contributors:
    - `Automations.Config` ← `infra.deps.updates`
    - `Automations.Config` ← `tasks.reports-investigation`
    - `Automations.Config` ← `tasks.sidequest-autopilot`
    - `Automations.Config` ← `upstream`
    - `Automations.Section` ← `tasks.reports-investigation`
    - `Automations.Section` ← `tasks.sidequest-autopilot`
    - `Automations.TaskDetail` ← `tasks.outcome-report`
    - `automations.actions` ← `primitives.pane`
    - `automation-detail.actions` ← `primitives.pane`
  - Contributes:
    - `DynamicEnum.Options` "Model"
    - `Pane.Register` "automation-detail"
    - `Pane.Register` "automations"
    - `Shell.Sidebar` "Automations"
    - `FieldPresentation.Register` "exposure:tasks_ext_origin"
  - Uses: 55 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives/css/ui-kit` ×7
    - `primitives/live-state` ×5
    - `primitives/pane` ×5
    - `network/live` ×4
    - `config_v2` ×3
    - `primitives/data-view` ×3
    - `tasks/task-status` ×3
    - `conversations/model-provider` ×2
    - `infra/background/catalog` ×2
    - `infra/endpoints` ×2
    - `primitives/css/control-panel` ×2
    - `fields/dynamic-enum/config.DynamicEnum`
    - `primitives/app-shell.opensPane`
    - `primitives/css/badge.Badge`
    - `primitives/css/fill.Fill`
    - `primitives/css/line.Line`
    - `primitives/css/placeholder.Placeholder`
    - `primitives/css/rigid.rigidClass`
    - `primitives/css/spacing.Stack`
    - `primitives/css/text.Text`
    - `primitives/editable-field.useEditableField`
    - `primitives/loading.Loading`
    - `primitives/relative-time.RelativeTime`
    - `primitives/slot-render.defineRenderSlot`
    - `shell.Shell`
    - `tasks/task-detail.taskDetailPane`
    - `tasks.useTasksById`
    - `ui/icons.Icon`
  - Exports (values):
    - `automationConfigContributions`
    - `Automations`
    - `PromptTemplateBlock`
- Server:
  - Contributes:
    - `resource.declare` "automations.catalog"
    - `resource.declare` "automations.launch-decisions.all"
    - `resource.declare` "automations.launch-decisions.all:rows"
    - `resource.declare` "automations.tasks"
    - `resource.declare` "automations.tasks:groups"
    - `resource.declare` "automations.tasks:rows"
    - `live.columns.expose` "tasks ← tasks_ext_origin"
    - `trigger` "automations.task-status"
  - Uses: 26 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `tasks/tasks-core` ×5
    - `config_v2` ×4
    - `network/live` ×3
    - `database` ×2
    - `infra/endpoints` ×2
    - `infra/jobs` ×2
    - `infra/entity-extensions.defineExtension`
    - `infra/events.Trigger`
    - `infra/warmup.defineWarmup`
    - `primitives/log-channels.Log`
    - `shell/notifications.recordNotification`
    - `tasks/auto-start.listArmedTaskIds`
    - `tasks/task-category.setTaskCategory`
    - `tasks.armTaskAutoStart`
  - DB schema: `plugins/tasks/plugins/automations/server/internal/tables.ts`
  - Entity extension of:
    - `tasks/tasks-core` (table `tasks-core_ext_launch_decision`)
    - `tasks/tasks-core` (table `tasks-core_ext_origin`)
  - Exports (types):
    - `Automation`
    - `AutomationDetectCtx`
    - `AutomationFiling`
    - `AutomationLaunchCtx`
    - `AutomationSpec`
    - `FileAutomationSpec`
    - `LaunchAutomationSpec`
    - `LaunchCandidate`
  - Exports (values):
    - `automationConfigRegistration`
    - `automationOfTask`
    - `defineAutomation`
    - `releaseLaunchedTask`
  - Register: `defineJob('automations.task-status')`
  - Resources:
    - `automations.catalog` (push, notified)
    - `automations.launch-decisions.all` (keyed)
    - `automations.launch-decisions.all:rows` (keyed, point)
    - `automations.tasks` (keyed, window)
    - `automations.tasks:groups` (push)
    - `automations.tasks:rows` (keyed, point)
  - Routes: `POST /api/automations/:automationId/launch-decisions`
- Core:
  - Uses: 25 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `config_v2` ×3
    - `conversations/model-provider` ×3
    - `fields/text/config` ×2
    - `network/live` ×2
    - `fields/bool/config.boolField`
    - `fields/date/config.dateField`
    - `fields/dynamic-enum/config.dynamicEnumField`
    - `fields/enum/config.enumField`
    - `fields/int/config.intField`
    - `fields/json/config.jsonField`
    - `fields/multiline-text/config.multilineTextField`
    - `fields/string-list/config.stringListField`
    - `fields.nullable`
    - `framework/plugin-id.asPluginId`
    - `infra/endpoints.defineEndpoint`
    - `infra/entity-extensions.defineExtensionShape`
    - `network/live/filter.liveText`
    - `primitives/pane.defineRoute`
    - `tasks/tasks-core.tasksEntityRef`
  - Exports (types):
    - `AutomationConfigDefaults`
    - `AutomationConfigFields`
    - `AutomationEntry`
    - `AutomationKind`
    - `AutomationSettings`
    - `AutomationSource`
    - `AutomationTaskRow`
    - `AutomationTrigger`
    - `Cadence`
    - `CadenceCron`
    - `LaunchAutomationConfigDefaults`
    - `LaunchAutomationConfigFields`
    - `LaunchDecision`
    - `LaunchDecisionRow`
    - `OriginRole`
    - `PromptVariable`
    - `PushPolicy`
    - `RenderedPrompt`
    - `ScheduleSettings`
    - `TriggerKind`
    - `Weekday`
  - Exports (values):
    - `AUTOMATION_KINDS`
    - `automationDetailRoute`
    - `AutomationEntrySchema`
    - `automationModelField`
    - `AUTOMATIONS_CONFIG_PLUGIN_ID`
    - `automationsCatalog`
    - `AutomationSettingsSchema`
    - `AutomationSourceSchema`
    - `automationsRoute`
    - `AutomationTaskRowSchema`
    - `automationTasks`
    - `AutomationTriggerSchema`
    - `CADENCE_LABELS`
    - `cadenceCron`
    - `CADENCES`
    - `cadenceWords`
    - `decideLaunchEndpoint`
    - `defineAutomationConfig`
    - `defineLaunchAutomationConfig`
    - `isLaunchAutomationConfig`
    - `labeledOptions`
    - `LAUNCH_DECISIONS`
    - `LaunchDecisionRowSchema`
    - `launchDecisions`
    - `launchDecisionShape`
    - `MAX_DECIDED_TASKS`
    - `MAX_LAUNCH_CONCURRENCY`
    - `MAX_LAUNCHES`
    - `ORIGIN_ROLES`
    - `PromptVariableSchema`
    - `PUSH_POLICIES`
    - `PUSH_POLICY_LABELS`
    - `PUSH_POLICY_TEXT`
    - `PUSH_POLICY_VARIABLE`
    - `readAutomationSettings`
    - `renderPrompt`
    - `ScheduleSettingsSchema`
    - `SETTLE_MAX_WAIT_FACTOR`
    - `SLOT_SETTLED_STATUSES`
    - `taskOriginShape`
    - `templateVariables`
    - `TRIGGER_KIND_LABELS`
    - `TRIGGER_KINDS`
    - `unknownTemplateVariables`
    - `WEEKDAY_LABELS`
    - `WEEKDAYS`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --foreground`
    - `ui/tokens/color-palette --input`
    - `ui/tokens/density --space-lg`
    - `ui/tokens/density --space-sm`
    - `ui/tokens/density --space-xs`
    - `ui/tokens/font-family --font-mono`
    - `ui/tokens/shape --radius`
    - `ui/tokens/shape --spacing`
    - `ui/tokens/type-scale --font-scale`
    - `ui/tokens/type-scale --font-size-caption`
    - `ui/tokens/type-scale --font-weight-normal`
    - `ui/tokens/type-scale --line-height-caption`
  - Imported by:
    - `infra/deps/updates`
    - `tasks/outcome-report`
    - `tasks/reports-investigation`
    - `tasks/sidequest-autopilot`
    - `upstream`
- Exemptions:
  - Exempts itself from: `no-db-backed-notify` — `server/internal/live.ts` (debt)

<!-- AUTOGENERATED:END -->
