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
  mandate: (settings) => mandatePolicy([…]),   // what its agent may do
  watch: null,                                 // or "refire" — see A file-kind run
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
  launched settles, stops or is held, or is released
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
5. In ONE transaction: `createTask` (author `automation:<id>`, the spec's
   `mandate` on it), its category, its origin row (role `filed`). Then, when
   its `watch` is `"refire"`, the `automations.refire` code watcher on the
   task; then `onFiled(taskId)`, then `armTaskAutoStart` with the chosen model.

**`watch`** (file kind, required, beside `mandate`) says what watches the task
it files. `"refire"`: the task settling (done / dropped — the `settled` watch
event) wakes the automation at once and ends the watch, so the next piece of
work is filed without waiting for its next event or schedule (Report
investigations). `null`: nothing; the next scheduled or fired run looks again —
for an automation whose detection would re-file a dropped task's same work
(Dependency upgrades, Upstream merges). A launch-kind automation declares none:
the `automations.slot` watcher is how its slots work (below).

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
3. Calls `candidates` (best first), keeps ONLY the tasks a person approved
   (see Approval), skips any task an automation already filed or launched (a task has ONE
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

**Approval.** `tasks_ext_launch_decision` (one row per task: `decision:
approved | excluded`, `decidedAt`) is the approved set. An approval is a fact
about the TASK, not about one automation: every launch-kind run reads the same
set (`approvedTaskIds()`) and intersects it with its own candidates, so nothing
outside them launches. It is written ONLY by a person's click, through two
endpoints:

- `taskApprovalEndpoint` (`PUT /api/tasks/:taskId/approval`, `{ approved }`) —
  from the task itself (the web barrel's `useSetTaskApproval()(taskId, approved)`;
  read back with `useTaskApproval(taskId)`, a point read of the set). `true`
  records `approved`, overwriting an `excluded`; `false` deletes only an
  `approved` row, so it never erases an exclusion. An approval wakes every
  launch-kind automation.
- `decideLaunchEndpoint` (`POST /api/automations/:automationId/launch-decisions`,
  `decision: null` clears) — from a launch list, in bulk. `:automationId` must
  be a launch-kind automation, which is woken on an approval; it is not stored.

Nothing on the server approves a task, and `candidates` cannot bypass the
filter: an automation only ranks. `excluded` is for a launch list's own review
(not proposed again); the pump ignores it. The catalog's `approvedCount` is
`pendingApprovalCount()` — approved, no origin row, task still `new` (a done,
dropped, held or already-started task waits on no automation) — the same for
every launch automation. Read two ways:

- `launchDecisions` (`automations.launch-decisions.all`), the whole ordered set
  (`all`, at most one row per task): a launch list joins it to every task it
  shows (`useLive(launchDecisions, { select })`); one task's is
  `useLiveRow(launchDecisions, taskId)` (`useTaskApproval`).
- EXPOSED (`launchDecisionShape.exposes`, served by
  `LiveColumns.Expose(tasksLaunchDecision)`): `decision` under the field id
  `approval` (**Approval**) in every list whose rows reach a task. No default:
  a task with no row reads NULL, presented as the quiet *Not approved* option
  (`web/internal/presentation.ts`, `approvalPresentation`).

Dedupe ("one open task") is file-kind only. A launched task stays the person's
task: its category, title and description are untouched; the role says the
automation only started it.

**Releasing a slot.** `runLaunch` makes the automation a code watcher of every
task it launches (`watchTask(task, { kind: "code", handler: "automations.slot",
key: automationId })`, `tasks/orchestration/watch`). For events on the task
itself:

- its report (`reported` / `asking`, the outcome-report watch source) →
  `releaseLaunchedTask(taskId)` — stamps the launched row's `releasedAt` and
  wakes the automation — and the watch ends, so a conversation left open for
  the person to read does not hold a slot;
- it settles, stops (`attempted`: its agent ended without landing) or is held
  (`settled` / `stopped` / `held`, the tasks watch sources) → the automation is
  woken, and its run counts the slot free from the task's status
  (`SLOT_SETTLED_STATUSES`). Not released: a held or attempted task that
  resumes takes its slot back, and the "Stopped before finishing" bell rings
  only while unreleased.

Nothing names this plugin: the report tool and the task statuses emit
events, the watch routes them. Every automation's
mandate grants `report.required` (its agents report; they cannot stop before).

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
Who must report is the mandate's (`report.required`), never "was this task
automated". Read two ways from the one table:

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
  automation's config changes, it files, launches or releases a task, or a
  status transition moves one of the catalog's three readings of a status
  (filing closed, slot settled, awaiting launch — `catalogStatusMoved`,
  `server/internal/catalog-status.ts`, the same constants the queries filter
  on) for a task an automation filed or launched, or a person approved —
  every such change in `server/` raises `catalogChanged()`
  (`server/internal/catalog-changed.ts`), which the serve turns into a
  recompute while subscribed. Its own tables (origin, launch decision, launch
  batch) are routed `reads`; `tasks_v` is a `notified` read
  (`network/live`), never routed: through the feed that view would recompute
  the catalog on every write to the tasks tree (every agent turn). The
  status reaches it only through `automations.task-status`. Declared `needsMachine`
  ("Automations") and served by the machine half
  (`machine/internal/catalog.ts`), since the automations it lists are
  config-bound until the config split; under an in-browser server the list,
  the detail pane and the sidequest launch list show the message, and the
  `origin` options offer "By hand" only.
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
- it re-pushes the catalog (below). Waking a launch-kind automation when its
  task settles is the `automations.slot` watcher's, not this job's.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Automations in the agent manager: the Automations sidebar entry and list (a DataView over the catalog — trigger in words, next run, on/off, open task), the detail pane (Run now through Background activity; Behavior — enabled, model, push policy; Trigger — schedule presets or custom cron, or the event and its settle wait; the sections an automation contributes through Automations.Section; its sources; the Prompt template with Customized / Reset to default — PromptTemplateBlock, the same editor for any template field an automation declares; and the History of the tasks it filed or started — each row expandable into the Automations.TaskDetail contributions for its task), the presentation of the exposed `origin` Automation field (its options the live catalog) and `approval` Approval field (Approved / Excluded / Not approved) in every list whose rows reach a task, useTaskApproval / useSetTaskApproval — one task's launch decision, read and written from the task, and automationConfigContributions — how a declaring plugin registers its automation's config document (Automations.Config). Automations registry: defineAutomation declares something that files a task and launches its agent on its own (file kind) or launches agents on existing tasks a few at a time (launch kind: candidates, launched ONLY when a person approved them — the tasks_ext_launch_decision side-table, one decision per task whatever automation launches it, written by the decide-launch and task-approval endpoints alone — concurrency slots held until a task settles or its agent reports — the automations.slot code watcher on every launched task, fed the outcome report and the task's settled / stopped / held facts through the watch plugin —, and a maxLaunches batch per turn-on after which it turns itself off), and owns its job (automation.<id>) — its config document (defineAutomationConfig: enabled, push policy, model, excluded sources, trigger — a schedule re-installed live on change, or an event whose bursts settle into one run — and the prompt template), the one-open-task dedupe (and, for a file automation whose `watch` is refire, the automations.refire code watcher on each filed task, running it again as soon as that task settles), the filled prompt, the filing (task + category + tasks_ext_origin row in one transaction) and the armed launch. Serves the automations.launch-decisions.all set, exposes the filing automation and the launch decision to every list whose rows reach a task (the `origin` and `approval` fields), and notifies the bell when an automated task needs its person. The automations.catalog value and the automations.tasks collection (the origin side-table, an automation's history) are the machine half's.
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
    - `FieldPresentation.Register` "exposure:tasks_ext_launch_decision"
    - `FieldPresentation.Register` "exposure:tasks_ext_origin"
    - `Notifications.Action` "review-automation"
  - Uses: 58 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives/css/ui-kit` ×7
    - `network/live` ×6
    - `primitives/live-state` ×6
    - `primitives/pane` ×5
    - `primitives/data-view` ×4
    - `config_v2` ×3
    - `infra/endpoints` ×3
    - `conversations/model-provider` ×2
    - `infra/background/catalog` ×2
    - `primitives/css/control-panel` ×2
    - `apps-core/tabs.useAppLink`
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
    - `primitives/slot-render.defineRenderSlot`
    - `shell/notifications.Notifications`
    - `shell.Shell`
    - `tasks/task-detail.taskDetailPane`
    - `tasks.useTasksById`
    - `ui/icons.Icon`
  - Exports (values):
    - `automationConfigContributions`
    - `Automations`
    - `PromptTemplateBlock`
    - `useSetTaskApproval`
    - `useTaskApproval`
- Server:
  - Contributes:
    - `live.columns.expose` "tasks ← tasks_ext_launch_decision"
    - `live.columns.expose` "tasks ← tasks_ext_origin"
    - `resource.declare` "automations.catalog"
    - `resource.declare` "automations.launch-decisions.all"
    - `resource.declare` "automations.launch-decisions.all:rows"
    - `resource.declare` "automations.tasks"
    - `resource.declare` "automations.tasks:groups"
    - `resource.declare` "automations.tasks:rows"
    - `watchHandler` "automations.refire"
    - `watchHandler` "automations.slot"
    - `mandateDefinitionSource` "automations"
    - `trigger` "automations.task-status"
  - Uses: 30 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `tasks/tasks-core` ×6
    - `config_v2` ×4
    - `tasks/orchestration/watch` ×3
    - `database` ×2
    - `infra/endpoints` ×2
    - `infra/jobs` ×2
    - `network/live` ×2
    - `infra/entity-extensions.defineExtension`
    - `infra/events.Trigger`
    - `infra/warmup.defineWarmup`
    - `primitives/log-channels.Log`
    - `shell/notifications.recordNotification`
    - `tasks/auto-start.listArmedTaskIds`
    - `tasks/orchestration/mandate/definitions.MandateDefinitions`
    - `tasks/task-category.setTaskCategory`
    - `tasks.armTaskAutoStart`
  - DB schema: `plugins/tasks/plugins/automations/server/internal/tables.ts`
  - Entity extension of:
    - `tasks/tasks-core` (table `tasks_ext_launch_decision`)
    - `tasks/tasks-core` (table `tasks_ext_origin`)
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
    - `defineAutomation`
  - Register: `defineJob('automations.task-status')`
  - Resources:
    - `automations.catalog` (push, notified, whole: every registered automation — declared in code, bounded by the composition, whole: the tasks one launch-kind automation holds a slot for — at most its concurrency, whole: what one automation watches — e.g. one per dependency updater, declared in code, whole: one automation's prompt variables — a handful, declared in code, capped: TRIGGER_KINDS.length)
    - `automations.launch-decisions.all` (keyed)
    - `automations.launch-decisions.all:rows` (keyed, point)
    - `automations.tasks` (keyed, window)
    - `automations.tasks:groups` (push)
    - `automations.tasks:rows` (keyed, point)
  - Routes:
    - `POST /api/automations/:automationId/launch-decisions`
    - `PUT /api/tasks/:taskId/approval`
- Machine:
  - Uses:
    - `network/live.serveCollection`
    - `network/live.serveValue`
- Core:
  - Uses: 29 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `config_v2` ×3
    - `conversations/conversation-view/push-and-exit/capabilities` ×3
    - `conversations/model-provider` ×3
    - `fields/text/config` ×2
    - `network/live` ×2
    - `packages/list-bound` ×2
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
    - `PUSH_POLICY_VARIABLE`
    - `readAutomationSettings`
    - `renderPrompt`
    - `ScheduleSettingsSchema`
    - `SETTLE_MAX_WAIT_FACTOR`
    - `SLOT_SETTLED_STATUSES`
    - `taskApprovalEndpoint`
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
    - `tasks/task-triage`
    - `upstream`

<!-- AUTOGENERATED:END -->
