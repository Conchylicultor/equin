# sidequest-autopilot

Works through the sidequests the person approves, in the background: Sonnet
reads each ready sidequest first (triage) and proposes it in the **launch
list**; the person approves what may run; once switched on, it starts agents on
the approved ones, best first, a few at a time and at most `maxLaunches` in
total, and each leaves a report the person reads when back. Design:
`research/2026-10-10-tasks-sidequest-autopilot.md` (phase 1) and
`research/2026-10-11-tasks-sidequest-autopilot-v2.md` (triage, approval, cap).

A `tasks/automations` automation of the **launch** kind (`kind: "launch"`, see
`plugins/tasks/plugins/automations/CLAUDE.md`), **off by default**.

**Nothing launches unless the person approved that task** — the automations
registry enforces it (only `decideLaunchEndpoint` writes approvals). Triage's
rating can at most pre-tick a row in the list.

## Config

`sidequest-autopilot` (`shared/config.ts`, `defineLaunchAutomationConfig`):
the common fields — default push `safe`, trigger `event` with a 2 min settle —
plus `concurrency` (default 2), `maxLaunches` (default 5), and its own:

- `runUntil` — `""` runs until it is turned off; an ISO datetime turns it off
  then (`shared/run-until.ts`; anything else throws).
- `triage` (default on) — whether new sidequests are read.
- `staleAfterDays` (default 7) — when a read is tagged Stale.
- `triagePrompt` — `SIDEQUEST_TRIAGE_PROMPT`, variables
  `TRIAGE_PROMPT_VARIABLES` (`taskId`, `title`, `description`, `filedAgo`,
  `recentCommits`).

The committed default is
`config/tasks/automations/sidequest-autopilot.origin.jsonc`, written by the
build.

## Triage

`server/internal/triage.ts`: one `runClaudeReadOnly` (`infra/claude-cli`) per
sidequest — Sonnet with ONLY Read / Grep / Glob over the main checkout (read-only
by what the CLI can do, not by the prompt), its answer a zod/v4 schema the CLI
is handed as `--json-schema` and parsed with. Stored in
`tasks_ext_sidequest_triage` (`shared/triage.ts`): `verdict` (`ready` /
`decide` / `split` / `obsolete`), free-form `context` (markdown, for a human),
`question` + 2–4 `answers` (or none), the person's `answer`, `risk`,
`sizeMinutes`, `value` 1–5, `areas`, the `mainSha` read and the task's
`sourceTitle` / `sourceDescription`. Served as `sidequest-autopilot.triage.all`,
the whole ordered set (`all`, at most one row per task): the launch list joins
it (and automations' `launchDecisions` set) to every ready sidequest.

- **When** (`server/internal/triage-jobs.ts`, main only, while `triage` is on):
  a task becomes a sidequest (`tasks.trackChanged`, task-track) or a sidequest
  becomes ready (`tasks.statusChanged` → `new`), with no row yet; a boot
  backfill (warm-up) and turning `triage` on queue every unread one. The job
  (`sidequest-autopilot.triage`) is keyed on the task and `serial`: one Sonnet
  at a time.
- **Once per task.** Never re-run on its own: a read is **stale** (derived,
  `triageStaleness`) once older than `staleAfterDays` or the task's title or
  description changed — shown, not acted on. Re-triage (`retriageEndpoint`) is
  the person's.
- **Answer** (`answerTriageEndpoint`) — one of triage's answers, fed to the
  agent as `{{decision}}`. It approves nothing.

## The launch list

`web/components/launch-list-section.tsx` — a DataView of every ready sidequest
(`shared/launch-list.ts` `launchListRows`), in launch order (triage's value for
size, `triageScore`; untriaged after, oldest first), grouped by `lane`:
Approved (rank, Remove) / Proposed by triage (a box, pre-ticked when the read
is fresh, `ready` and low risk, or its question was answered) / Needs your call
(the question, one-click answers) / Looks obsolete (Drop task) / Triaging /
Excluded (Restore). **Approve selected** writes the ticked rows as approved;
nothing else does. The header says what turning it on will do (how many of the
approved it launches, how many at a time).

## What it launches

`candidates` (`server/internal/automation.ts`): the sidequests whose derived
status is `new` — no attempt, and not held, dropped or blocked — at most 200
per run (`task-track`'s `listSidequestTasks`), ranked like the launch list
(`server/internal/candidates.ts`). The automations registry keeps only the
approved, skips the ones some automation already filed or launched, or someone
armed, and fills the free slots (and what is left of the batch) from the rest.
Prompt variables: `taskId`, `title`, `description`, `context` (triage's, or a
note), `decision` (triage's question and the person's answer, or a note), plus
`pushPolicy`.
## The agent's prompt

`SIDEQUEST_AUTOPILOT_PROMPT` (editable in the pane's Prompt section): never ask
questions or wait; check the task is not obsolete first (if it is, change
nothing and ask whether to drop it — agents cannot drop tasks); stay in scope
and file extras with `add_task` on the sidequest track; stop early when it is
too big or needs a design choice; never touch migrations, auth or the gateway
without leaving the push to the person; `{{pushPolicy}}`; finish with ONE
`submit_outcome_report` (problem and why we care, mental model before → after,
what changed, caveats, at most one decision question) and do NOT
`exit_clean` — the conversation stays open in the person's queue.
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

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: The Sidequest autopilot in the Automations pane: registers its config (enabled, at once, in total, push policy, model, prompt, triage, stale after, triage prompt) and contributes its sections — Launch list (a DataView of every ready sidequest in launch order, grouped Approved / Proposed by triage / Needs your call / Looks obsolete / Triaging / Excluded; each row expands to triage's context, its one-click question and Re-triage; triage may tick a row, only Approve selected approves), Run until (until you turn it off, or until a date and time after which it turns itself off) and Triage (the switch, stale after, the triage prompt). Declares the Sidequest autopilot automation (launch kind, off by default): while on, it starts agents on the ready sidequests (no attempt, not held, dropped or blocked) a person APPROVED in its launch list — best first by triage's value for size, `concurrency` at a time (default 2), at most `maxLaunches` per turn-on (default 5) — each with the autopilot prompt (triage's context and the person's answer included; never ask, check obsolescence first, stay in scope, push only what the push policy allows, finish with submit_outcome_report). Triage (on by default, main only): each ready sidequest is read once by a read-only Sonnet run (Read / Grep / Glob over the main checkout) — verdict ready / decide / split / obsolete, risk, size, value, areas, a free-form context and at most one one-click question — stored in tasks_ext_sidequest_triage and served as the sidequest-autopilot.triage.all set; queued when a task becomes a sidequest or a sidequest becomes ready, backfilled at boot, re-run only by the person's Re-triage. Triage approves nothing. Turns itself off at its `runUntil`.
- Web:
  - Contributes:
    - `ConfigV2.WebRegister` "sidequest-autopilot"
    - `Automations.Config` "sidequest-autopilot"
    - `Automations.Section` "sidequest-autopilot" → `LaunchListSection`
    - `Automations.Section` "sidequest-autopilot" → `RunUntilSection`
    - `Automations.Section` "sidequest-autopilot" → `TriageSection`
  - Uses: 37 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives/css/ui-kit` ×7
    - `primitives/data-view` ×3
    - `primitives/live-state` ×3
    - `tasks/automations` ×3
    - `config_v2` ×2
    - `infra/endpoints` ×2
    - `primitives/css/control-panel` ×2
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
    - `tasks.patchTask`
- Server:
  - Contributes:
    - `ConfigV2.Register` "sidequest-autopilot"
    - `resource.declare` "sidequest-autopilot.triage.all"
    - `resource.declare` "sidequest-autopilot.triage.all:rows"
    - `trigger` "sidequest-autopilot.task-ready"
    - `trigger` "sidequest-autopilot.triage-on-task"
    - `trigger` "sidequest-autopilot.triage-on-task"
  - Uses: 23 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `config_v2` ×3
    - `tasks/task-track` ×3
    - `tasks/tasks-core` ×3
    - `infra/endpoints` ×2
    - `tasks/automations` ×2
    - `database.db`
    - `infra/claude-cli.runClaudeReadOnly`
    - `infra/entity-extensions.defineExtension`
    - `infra/events.Trigger`
    - `infra/jobs.defineJob`
    - `infra/warmup.defineWarmup`
    - `infra/worktree.ensureMainWorktreeRoot`
    - `network/live.serveCollection`
    - `primitives/commit-list.runGit`
    - `primitives/log-channels.Log`
  - DB schema: `plugins/tasks/plugins/sidequest-autopilot/server/internal/tables.ts`
  - Entity extension of: `tasks/tasks-core` (table `tasks_ext_sidequest_triage`)
  - Register:
    - `defineAutomation('sidequest-autopilot')`
    - `defineJob('sidequest-autopilot.task-ready')`
    - `defineJob('sidequest-autopilot.run-until')`
    - `defineJob('sidequest-autopilot.triage')`
    - `defineJob('sidequest-autopilot.triage-on-task')`
    - `defineJob('sidequest-autopilot.triage-backfill')`
    - `defineWarmup('sidequest-autopilot.triage-backfill')`
  - Resources:
    - `sidequest-autopilot.triage.all` (keyed)
    - `sidequest-autopilot.triage.all:rows` (keyed, point)
  - Routes:
    - `POST /api/sidequest-autopilot/triage/:taskId/run`
    - `PUT /api/sidequest-autopilot/triage/:taskId/answer`
- Cross-plugin:
  - Uses tokens: `ui/tokens/shape --spacing`

<!-- AUTOGENERATED:END -->
