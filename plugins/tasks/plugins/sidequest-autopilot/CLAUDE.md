# sidequest-autopilot

Works through the sidequests the person approves, in the background: each
ready sidequest is triaged first (task-triage's read-only agent) and proposed in
the **launch list**; the person approves what may run; once switched on, it
starts agents on the approved ones, best first, a few at a time and at most
`maxLaunches` in total, and each leaves a report the person reads when back.
Design: `research/2026-10-10-tasks-sidequest-autopilot.md` (phase 1),
`research/2026-10-11-tasks-sidequest-autopilot-v2.md` (triage, approval, cap)
and `research/2026-10-22-tasks-task-triage-card.md` (triage moved to
`tasks/task-triage`; MoSCoW priority).

A `tasks/automations` automation of the **launch** kind (`kind: "launch"`, see
`plugins/tasks/plugins/automations/CLAUDE.md`), **off by default**.

**Nothing launches unless the person approved that task** — the automations
registry enforces it (approval is a fact about the task, written by
`decideLaunchEndpoint` or the task's Triage card). Triage's rating can at most
pre-tick a row in the list.

## Config

`sidequest-autopilot` (`shared/config.ts`, `defineLaunchAutomationConfig`):
the common fields — default push `safe`, trigger `event` with a 2 min settle —
plus `concurrency` (default 2), `maxLaunches` (default 5), and its own:

- `runUntil` — `""` runs until it is turned off; an ISO datetime turns it off
  then (`shared/run-until.ts`; anything else throws).
- `triage` (default on) — "Triage new sidequests automatically": whether it
  asks task-triage for a read of each new sidequest.

How a read runs — model, prompt, concurrency, stale age — is task-triage's
config (Settings → Config → task-triage), not this one.

The committed default is
`config/tasks/automations/sidequest-autopilot.origin.jsonc`, written by the
build.

## Triage

Triage is `tasks/task-triage`'s (its CLAUDE.md): one read per task in
`tasks_ext_triage` — run state, verdict, MoSCoW `priority`, `taskType`, risk,
context, one one-click question — plus the person's note
(`tasks_ext_triage_note`). This plugin is a consumer:

- **Asks for reads** (`server/internal/triage-requests.ts`, main only, while
  `triage` is on): when a task becomes a sidequest (`tasks.trackChanged`,
  task-track) or a sidequest becomes ready (`tasks.statusChanged` → `new`), a
  boot backfill (warm-up) and turning `triage` on — each calls task-triage's
  `requestTriage(taskId, { force: false })`, which leaves a task with a read
  (or a run in flight) alone and queues the rest.
- **Reads them** — the launch list through `useLive(taskTriageReads, { ids })`
  (the triage of exactly the ready sidequests shown), the candidates through
  `triageReadsOf` / `triageNotesOf`; both parse rows into task-triage's
  `TriageRead` and judge a row by `latestTriageResult` (a run in flight or
  failed keeps the read it would replace). Both rank with task-triage's one
  comparator, `compareByTriage` (priority must → should → could → won't,
  untriaged after, then oldest filed), so they cannot drift.
- **Stale** is the read's own `state` (written by task-triage), never computed
  here. Re-triage / Triage now and the one-click answer call task-triage's
  endpoints (`runTriageEndpoint`, `answerTriageEndpoint`).

## The launch list

`web/components/launch-list-section.tsx` — a DataView of every ready sidequest
(`shared/launch-list.ts` `launchListRows`), in launch order
(`compareByTriage`), grouped by `lane`: Approved (rank, Remove) / Proposed by
triage (a box, pre-ticked when the read is fresh — `done` — and either rates it
`ready`, `must` or `should` and low risk, or its question was answered) / Needs
your call (the question, one-click answers) / Looks obsolete / won't (verdict
`obsolete` or priority `wont`; Drop task) / Triage failed (its only run ended
without a read) / Triaging (queued, running or never asked) / Excluded
(Restore). Each row shows its priority and type chips (task-triage's
`*_META`), its verdict, risk and staleness. **Approve selected** writes the
ticked rows as approved; nothing else here does. The header says what turning
it on will do (how many of the approved it launches, how many at a time).

## What it launches

`candidates` (`server/internal/automation.ts`): the sidequests whose derived
status is `new` — no attempt, and not held, dropped or blocked — at most 200
per run (`task-track`'s `listSidequestTasks`), ranked like the launch list
(`server/internal/candidates.ts`). The automations registry keeps only the
approved, skips the ones some automation already filed or launched, or someone
armed, and fills the free slots (and what is left of the batch) from the rest.
Prompt variables: `taskId`, `title`, `description`, `context` (triage's, or a
note), `decision` (triage's question and the person's answer, or a note),
`note` (the person's note from the task's Triage card, or a note that there is
none), plus `pushPolicy`.

## The agent's prompt

`SIDEQUEST_AUTOPILOT_PROMPT` (editable in the pane's Prompt section) hands the
agent triage's `{{context}}`, the person's `{{decision}}` and `{{note}}`, then: never ask
questions or wait; check the task is not obsolete first (if it is, change
nothing and ask whether to drop it — agents cannot drop tasks); stay in scope
and file extras with `add_task` on the sidequest track; stop early when it is
too big or needs a design choice; never touch migrations, auth or the gateway
without leaving the push to the person; `{{pushPolicy}}`; finish with ONE
`submit_outcome_report` (problem and why we care, mental model before → after,
what changed, caveats, at most one decision question) and do not
`exit_clean` on its own — the conversation stays open in the person's queue
(its mandate grants `exit.clean` only so a person can later ask it to exit).
`submit_outcome_report` and the slot release on submit belong to the
outcome-report plugin; this plugin only asks for them.

## When it runs

- **A task becomes ready** — a `tasks.statusChanged` trigger filtered to
  `status: "new"` (`server/internal/ready-job.ts`) calls the handle's `fire()`
  for ANY task (on creation its track row may not be written yet; `fire()` is
  an in-process no-op while off), so a burst settles into one run.
- **A slot frees, its config changes, the backend boots, the person approves
  tasks** — the automations registry wakes launch-kind automations itself.
- **Run now** in the pane.

## Run until

When `runUntil` passes, the autopilot writes `enabled: false` to its own config
(`setConfig`, `systemOrigin`) — exactly as if the person had switched it off,
so the pane, the catalog and the pump all agree. Two paths reach it: the
`sidequest-autopilot.run-until` job, queued for that instant whenever the
config changes and at boot (singleton; an edited end moves the pending run),
and every pump run, which checks it before launching. Agents already running
finish and report.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: The Sidequest autopilot in the Automations pane: registers its config (enabled, at once, in total, push policy, model, prompt, triage) and contributes its sections — Launch list (a DataView of every ready sidequest in launch order — triage's priority, then oldest — grouped Approved / Proposed by triage / Needs your call / Looks obsolete / won't / Triage failed / Triaging / Excluded; each row shows its priority and type, and expands to triage's context, its one-click question and Re-triage; triage may tick a row, only Approve selected approves), Run until (until you turn it off, or until a date and time after which it turns itself off) and Triage (whether new sidequests are triaged automatically). Declares the Sidequest autopilot automation (launch kind, off by default): while on, it starts agents on the ready sidequests (no attempt, not held, dropped or blocked) a person APPROVED — best first by triage's priority (must → should → could, then oldest filed), `concurrency` at a time (default 2), at most `maxLaunches` per turn-on (default 5) — each with the autopilot prompt (triage's context, the person's answer and their note included; never ask, check obsolescence first, stay in scope, push only what the push policy allows, finish with submit_outcome_report). Triage is task-triage's: while the `triage` toggle is on (default, main only) it asks task-triage for a read of each ready sidequest that has none — when a task becomes a sidequest or a sidequest becomes ready, backfilled at boot and when the toggle turns on. Triage approves nothing. Turns itself off at its `runUntil`.
- Web:
  - Contributes:
    - `ConfigV2.WebRegister` "sidequest-autopilot"
    - `Automations.Config` "sidequest-autopilot"
    - `Automations.Section` "sidequest-autopilot" → `LaunchListSection`
    - `Automations.Section` "sidequest-autopilot" → `RunUntilSection`
    - `Automations.Section` "sidequest-autopilot" → `TriageSection`
  - Uses: 32 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives/live-state` ×4
    - `primitives/data-view` ×3
    - `config_v2` ×2
    - `infra/endpoints` ×2
    - `primitives/css/control-panel` ×2
    - `primitives/css/ui-kit` ×2
    - `tasks/automations` ×2
    - `network/live.useLive`
    - `primitives/css/badge.Badge`
    - `primitives/css/fill.Fill`
    - `primitives/css/line.Line`
    - `primitives/css/rigid.rigidClass`
    - `primitives/css/selection-indicator.CheckboxIndicator`
    - `primitives/css/spacing.Stack`
    - `primitives/css/text.Text`
    - `primitives/loading.Loading`
    - `primitives/markdown.Markdown`
    - `primitives/pane.useOpenPane`
    - `primitives/relative-time.RelativeTime`
    - `tasks/task-detail.taskDetailPane`
    - `tasks/task-track.useStoredTracks`
    - `tasks.usePatchTask`
- Server:
  - Contributes:
    - `ConfigV2.Register` "sidequest-autopilot"
    - `trigger` "sidequest-autopilot.task-ready"
    - `trigger` "sidequest-autopilot.triage-on-task"
    - `trigger` "sidequest-autopilot.triage-on-task"
  - Uses:
    - `config_v2.getConfig`
    - `config_v2.setConfig`
    - `config_v2.watchConfig`
    - `infra/events.Trigger`
    - `infra/jobs.defineJob`
    - `infra/warmup.defineWarmup`
    - `primitives/log-channels.Log`
    - `tasks/automations.automationConfigRegistration`
    - `tasks/automations.defineAutomation`
    - `tasks/task-track.getTaskTrack`
    - `tasks/task-track.listSidequestTasks`
    - `tasks/task-track.taskTrackChanged`
    - `tasks/task-triage.requestTriage`
    - `tasks/task-triage.triageNotesOf`
    - `tasks/task-triage.triageReadsOf`
    - `tasks/tasks-core.taskStatusChanged`
  - Register:
    - `defineAutomation('sidequest-autopilot')`
    - `defineJob('sidequest-autopilot.task-ready')`
    - `defineJob('sidequest-autopilot.run-until')`
    - `defineJob('sidequest-autopilot.triage-on-task')`
    - `defineJob('sidequest-autopilot.triage-backfill')`
    - `defineWarmup('sidequest-autopilot.triage-backfill')`

<!-- AUTOGENERATED:END -->
