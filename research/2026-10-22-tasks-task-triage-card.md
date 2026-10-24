# Task triage card

Prototype: `proto-1792509675-bgqp52` (v3, the carded layout).

## Context

Triage exists today only inside `tasks/sidequest-autopilot`. It has three limits:

- It runs only on sidequests, and only on its own while the autopilot's `triage` toggle is on.
- It is a **headless** `runClaudeReadOnly` call (`--no-session-persistence`), so there is no conversation to open and nothing to ask a follow-up in.
- Its result is visible only in the Automations pane's launch list.

The user wants triage to be a property of **any task**:

- A **Triage card** in the task detail that can run triage on demand, whether or not the autopilot is on.
- A live indicator while triage is running.
- A link to the conversation that ran it, to ask follow-up questions there.
- A free-text note.
- An **Approve** button that works whether or not triage has run.
- The time of the last run, with a stale state and Re-run.
- Task lists that can filter, sort and group by triage state.

The result's **value (1–5) and size (minutes) are replaced** by two dimensions:

- **Priority**, as MoSCoW for the current timebox:
  - `must`: without it, the release is not viable.
  - `should`: painful to omit, but there is a workaround.
  - `could`: desirable; the first thing cut.
  - `wont`: explicitly out of scope this time.
- **Type**: `feature` · `bugfix` (something is actually broken) · `cleanup` · `testing` · `other`.

## Decisions

1. **Triage becomes its own plugin, `tasks/plugins/task-triage`.**
   - It owns the result table, how a run happens, the card, the list fields and the config.
   - `sidequest-autopilot` becomes a *consumer*. It asks for triage of new sidequests (`requestTriage`) and reads the result to rank and pre-tick its launch list.
   - This follows collection–consumer separation: triage does not know about the autopilot.
2. **A triage run is a real conversation, not a headless call.** The requirement to open the conversation and ask follow-ups needs a resumable session that shows in the UI.
   - **No precedent:** no read-only conversation in the main checkout exists today. The pattern is copied from transcription's scratch profile + submit tool.
   - **Workspace:** a scratch profile, `tasks.triage`. Its CLAUDE.md is **static** (`instructions` is sync and sees only the profile input `{taskId}`): the role, the absolute path of the main checkout to read, the output contract and the tool contract.
   - **Launch prompt:** the per-task data goes in `createConversation({prompt})`. That is the configured `prompt` rendered with `title, description, filedAgo, recentCommits, note`, read at launch exactly as `sidequest-autopilot/server/internal/triage.ts:60-105` does today. Recent commits must be in the prompt, because Bash is denied.
   - **Read-only comes from `deny` alone.** Conversations run in `bypassPermissions` (`runtime-sdk/bin/agent.ts:242`), so an `allow` scope means nothing.
     - The profile denies `Edit`, `Write`, `NotebookEdit` and `Bash`.
     - No profile uses `deny` yet, so **step 0 proves it holds under bypass mode**: add the deny to `debug/scratch-hello` and try a Write.
     - If it does not hold, stop and redesign. One option is a `canUseTool` gate driven by the profile.
   - **Reporting:** the agent reports through an MCP tool, `task_submit_triage`, scoped by `profiles: ["tasks.triage"]`.
     - Its Zod input schema is the result schema below.
     - The triaged task comes from the workspace input, never from the agent.
     - Calling it again in a later turn **updates** the read.
   - **Follow-ups need Resume.**
     - After submitting, the agent calls `exit_clean`, which closes the conversation (`done`), so idle runs do not pile up as "needs action".
     - **Conversation ↗** opens it, and the conversation view's Resume (`resumeConversation` accepts `done`) continues it. Asking "are you sure it's a must?" can resubmit and update the card live.
     - The scratch dir is reaped a week after the run task is done, which blocks a later Resume. The card then offers only Re-run, a fresh conversation that sees the note.
   - **The run's own task.** The conversation needs a task, and it cannot be an attempt of the triaged task: an attempt would move that task out of `new`, so the autopilot would no longer pick it.
     - Each run gets a small task `Triage: <title>`, created with `titleAuto: false` so no Haiku title job runs.
     - The task is in the existing **System** category, and the conversation is `kind: "system"`. Precedent: the conversation summary, `conversations/summary/server/internal/handle-generate.ts:44`.
     - **Kept out of the Queue:** a `system` conversation is served in `conversationsSystem`, never `conversationsActive`. The Queue and History sidebar are built on `conversationsActive`, and `attemptRows` leaves out `kind = 'system'`, so a triage run never appears there, even while it is running. It is reached only from the card (`conversationsById` finds it whatever its kind or age).
     - Its subject (`setTaskSubject`) has kind **`task-triage`** (specific, so it cannot collide with other subject links) and the triaged task's id.
     - Re-runs reuse it as new conversations via `findSubjectTask`, which returns done tasks too. Each new conversation is a new attempt with its own scratch dir.
     - It closes as delivered (`recordScratchDelivery`).
     - Triaging a run task (one whose subject kind is `task-triage`) is refused (400), so a "Triage: Triage: …" chain cannot start.
   - `spawnedBy: "task-triage"`. The model is Sonnet by default (config `model`).
3. **The run state is stored, not inferred.**
   - `state` is one of `queued | running | done | stale | failed`. A missing row is `null`, labelled **Not triaged**.
   - `stale` is *written*, so lists can filter by it with no code in task-list.
     - **Edited:** triggers on `tasks.titleChanged` and a **new `tasks.descriptionChanged`**. Both mark a `done` read stale *only if* the task now differs from the read's `sourceTitle` / `sourceDescription` snapshot.
       - `titleChanged` also fires on creation and on every Haiku title upgrade, so a raw trigger would mark fresh reads stale. The snapshot check prevents that.
       - Both events are global, so the handler returns early for a task with no triage row.
       - `tasks.descriptionChanged` is added in tasks-core with the same `defineTriggerEvent` pattern (`tables-events.ts`). It is emitted from `updateTaskOn` when `patch.description` is set (`mutations/tasks.ts:140`) and registered in `tasks-core/server/index.ts`. `task-description` has no server half.
     - **Old:** a `defineJob` schedule (hourly) marks reads older than `staleAfterDays` stale. A schedule is needed because the passage of time sends no event.
   - **`failed`, so no row stays stuck:**
     - The conversation closes (`done`) while the row is still `running`, with no submit. This is a `conversation.statusChanged` trigger, returning early for a non-triage task as transcription's `conversation-status.ts` does. `gone` is resumable, not a failure.
     - The dispatcher's launch throws. It pre-checks `assertClaudeCodeReady` and `assertChoiceLaunchable`, and a try/catch writes `failed` and rethrows.
     - The same hourly job fails `running` rows with no submit after 30 min. That is the backstop for a conversation that died without a status change, so a stuck row can never hold a `concurrency` slot for good.
4. **Concurrency goes through a dispatcher, not a serial job.** A conversation outlives the job that spawns it.
   - `requestTriage(taskId, {force})` writes `queued` and wakes `task-triage.dispatch`.
   - That job launches queued runs while fewer than `concurrency` (config, default 2) are `running`.
   - It is woken again on every submit, fail or close. It is push-based, with no polling.
   - A Run press from the card is queued first, so the card shows "Queued (2 ahead)".
5. **Approval moves to the task level.**
   - `tasks_ext_launch_decision` already holds one row per task (PK `parent_id`). Its `automationId` scopes a decision that cannot coexist with another automation's anyway, and today the sidequest autopilot is the only launch automation.
   - The approval becomes a fact about the task, so the `automationId` column is **dropped**. Every consumer is updated to match:
     - `approvedTaskIds()` takes no automation. It is still intersected with each automation's own candidates in `selectLaunches`, so nothing outside the candidate set can launch.
     - `pendingApprovalCounts()` becomes one count: approved ∧ no origin row ∧ the task's status is `new`. The catalog's `approvedCount` reads it for every launch automation. Without the status filter, done, dropped and main-track tasks would inflate the count.
     - `decideLaunch`'s clear path deletes by `taskId` only.
     - The launch list's `r.automationId === SIDEQUEST_AUTOPILOT_ID` filter (`launch-list-section.tsx:77`) is removed. A task approved from the card shows as Approved there.
     - `sets-all.test.ts` and `resources.test.ts` are updated.
   - automations owns a new endpoint, `PUT /api/tasks/:taskId/approval` with body `{approved: boolean}`.
     - `true` upserts `approved`, overwriting an `excluded`.
     - `false` deletes only an `approved` row, so it never silently erases an exclusion.
   - automations exposes `decision` on the tasks entity as the list field **Approval**. The field has no default; its `"null"` option is labelled *Not approved*.
   - The card's Approve button is independent of triage. Its hint text says so.
6. **The note gets its own small extension, `tasks_ext_triage_note`, in task-triage.**
   - The note exists before any triage has run, so it is not a nullable column on the result row.
   - It is fed into:
     - each triage run's prompt (`{{note}}`);
     - the autopilot's launch prompt (`{{note}}` beside `{{context}}` and `{{decision}}`).
   - Feeding it into *every* manual launch needs a first-turn contribution seam. Preprompts are hard-wired in `conversations/server/internal/lifecycle.ts` today. This is a follow-up and is out of scope (see the end).
7. **Data migration: start fresh.** The new table replaces `tasks_ext_sidequest_triage`, whose `value` and `sizeMinutes` do not map to MoSCoW.
   - The old table is dropped in the same migration.
   - Sidequests are re-read by the autopilot backfill while its `triage` toggle is on, capped by `concurrency`.
   - Other tasks show *Not triaged*.

## Data model (`task-triage/shared/shape.ts`)

`taskTriageShape = defineExtensionShape({ key: "taskId", fields, exposes })` gives the table `tasks_ext_triage`:

| field | type | notes |
|---|---|---|
| `state` | `enumTextField(TRIAGE_STATES)` | `queued·running·done·stale·failed`. Exposed as **Triage** with no default, so a missing row reads `null`. `options` labels every value plus `"null"` → *Not triaged* (pattern: `task-category/shared/resources.ts`). |
| `staleReason` | nullable `enumTextField(["old","edited"])` | Shown in the card notice. |
| `sourceTitle`, `sourceDescription` | nullable text | Snapshot of the task when the read was submitted. The edited-stale check compares against it. |
| `conversationId` | nullable text | The latest run's conversation, for **Conversation ↗**. |
| `runTaskId` | nullable text | The run's own task. |
| `requestedAt` | date | Orders the queue. |
| `triagedAt` | nullable date | Exposed as **Last triaged** (sortable). |
| `verdict` | nullable `enumTextField(ready·decide·split·obsolete)` | |
| `priority` | nullable `enumTextField(must·should·could·wont)` | Exposed as **Priority**, ordered must → wont. |
| `taskType` | nullable `enumTextField(feature·bugfix·cleanup·testing·other)` | Exposed as **Type**. |
| `risk` | nullable `enumTextField(low·medium·high)` | |
| `context` | nullable text | Markdown. |
| `question`, `answers`, `answer` | as today | `answer` is set by the person. |
| `areas` | json `string[]` | |
| `mainSha` | nullable text | |

**Why the result fields are nullable.** A queued or running row has no result yet. The web reads the row through a parsed union (`TriageRead = {state:"queued"|"running"|"failed"} | {state:"done"|"stale", …result}`) in `core/`, so a consumer cannot reach a result in the wrong state. The parse throws on a `done` row missing a result field.

**Serving.**
- `serveCollection(taskTriageRows)` is lookup-by-id for the card (`useLiveRow`), plus a `where state in (…)` window for the autopilot's launch list. It is not whole-set.
- `LiveColumns.Expose(tasksTriage)` exposes the list fields.
- `FieldPresentation.Register` supplies the chips.

The **submit tool's input schema** (`core/result.ts`, zod): `verdict, priority, taskType, risk, context, question|null, answers[0..4], areas[0..12]`. Question and answers are kept only together, as today.

## Endpoints (`task-triage/core/endpoints.ts`)

- `POST /api/tasks/:taskId/triage`: Run or Re-run. Calls `requestTriage(force)`. Works on any task and any track, whether or not the autopilot is on.
- `PUT /api/tasks/:taskId/triage/answer`: body `{answer|null}`. Moved from the autopilot.
- `PUT /api/tasks/:taskId/triage/note`: body `{note}`. Autosaved by the card (`useRegisterFlush`).

## Config (`task-triage/shared/config.ts`, Settings → Config)

- `model` (default sonnet)
- `concurrency` (default 2)
- `staleAfterDays` (default 7)
- `prompt`: the triage instructions, moved from the autopilot's `triagePrompt`. It is rewritten for MoSCoW and type. It explains each MoSCoW level in the user's words and defines `bugfix` as "something is actually broken". Variables: `taskId, title, description, filedAgo, recentCommits, note`.

The autopilot keeps only `triage` (bool): "Triage new sidequests automatically".

## UI

**Triage card.** `TaskDetailSlots.Section({ id: "triage", label: "Triage", summary, actions, component })`, laid out as in v3 of the prototype:
- `summary`: the state badge plus "Ran 2h ago" or "Queued · 2 ahead".
- `actions`:
  - **Conversation**: `useConversationOpener().toggle(conversationId)`. Shown whenever a run exists, including while it is running.
  - **Re-run**: shown on a `done` read.
- **Body:**
  - **None:** one sentence and a **Run triage** button.
  - **Queued / running:** pulsing placeholder lines.
  - **Stale:** an amber notice with its reason and Re-run inside it.
  - **Failed:** an error line, Re-run, and a link to the conversation.
  - **Read:** a four-cell stats row (Verdict · Priority · Type · Risk), the Summary, then the question block with selectable answers.
  - **Note** field (labelled).
- **Footer:** an **Approve** / **✓ Approved** toggle with the hint "Approval doesn't require a triage".

**Task lists.**
- The exposed fields (Triage, Priority, Type, Last triaged, Approval) appear in every task DataView's filter, sort and group with no code in task-list.
- The tasks pane gets no saved view by default; the fields are just there. The prototype's tabs map to quick filters on Triage and Approval if the DataView offers them.

**Autopilot launch list.**
- Ranked by priority (must → should → could), then filed date. `wont` joins the **Looks obsolete / won't** lane.
- `preTicked` = fresh read ∧ (`ready` with `must`/`should` and low risk, or a question answered).
- The value/size caption becomes priority · type.
- `triageScore` is deleted. Its two call sites (`shared/launch-list.ts`, `server/internal/candidates.ts`) share one comparator, `compareByTriage`, in task-triage `core/`, so they cannot drift.

## Implementation steps

0. **Prove that `deny` holds under bypass mode.**
   - Add `permissions.deny: ["Write"]` to `debug/scratch-hello`'s profile, launch it, and ask it to write a file.
   - If the write succeeds, stop and redesign the read-only gate before going further.
   - Revert the probe afterwards.
1. **Scaffold `tasks/plugins/task-triage`.**
   - `core/`: states, result schema, `TriageRead` parse, `compareByTriage`, endpoints, the live collection.
   - `shared/`: shape, config.
   - `server/`: tables, profile, MCP tool, dispatcher job, triggers, stale sweep, routes, `requestTriage` export.
   - `web/`: section, presentation.
2. **Scratch profile `tasks.triage`.**
   - Static `instructions`: the role, the main-checkout path, and the tool contract: "call `task_submit_triage`, write two lines, `exit_clean`; when a resumed follow-up changes your read, submit again".
   - `permissions.deny: ["Edit","Write","NotebookEdit","Bash"]`.
   - `mcpTools: ["task_submit_triage", "exit_clean", "flag_raise"]`.
3. **Launch.** The dispatcher:
   1. Calls `assertClaudeCodeReady` and `assertChoiceLaunchable`.
   2. Inside `withSubjectLock({kind:"task-triage", id})`, calls `findSubjectTask`, or else `createTask({titleAuto:false})` + `setTaskCategory("system")` + `setTaskSubject`.
   3. Calls `createConversation({taskId: runTaskId, kind:"system", spawnedBy:"task-triage", model, prompt: renderedPrompt, workspace: {kind:"scratch", profile:"tasks.triage", input:{taskId}}})`.
   4. Writes `running`, `conversationId` and `runTaskId`.
   - A throw anywhere writes `failed` and rethrows.
4. **Submit tool.**
   - Validate the input.
   - Upsert the result: `done`, `triagedAt`, `mainSha`, the `sourceTitle`/`sourceDescription` snapshot, `staleReason: null`.
   - Call `recordScratchDelivery`, which is idempotent per attempt, so a resumed resubmit is safe.
   - Wake the dispatcher.
5. **Events and triggers.**
   - Add `tasks.descriptionChanged` to tasks-core.
   - Title or description changed and differs from the snapshot → stale(edited).
   - The hourly job marks reads past `staleAfterDays` stale(old), and fails `running` rows with no submit after 30 min.
   - Conversation `done` while `running` → failed and wake the dispatcher.
6. **Approval** in automations: drop the `automationId` column and update `approvedTaskIds`, `pendingApprovalCounts` (status `new` filter), `decideLaunch`'s clear, and the launch-list filter. Add the approval endpoint, and expose `decision` as **Approval** (`"null"` → Not approved).
7. **Rewire the autopilot.**
   - Delete `triage.ts`, `triage-jobs.ts`, `tables.ts` (the triage table), `triage-reads.ts`, the triage endpoints, `triagePrompt` and `staleAfterDays`.
   - The `tasks.trackChanged` / `statusChanged → new` triggers and the backfill call task-triage's `requestTriage`, gated by its `triage` toggle and main-only as today.
   - The launch list and candidates read task-triage's collection and comparator. `{{note}}` is added to its prompt.
   - `triage-section.tsx` keeps only the toggle and links to task-triage's config.
8. **Card UI** (`web/components/triage-card.tsx`) per the prototype, from `primitives/css` layout primitives, `ui-kit` `Button`, and `Loading`.
9. **Docs.** task-triage's `CLAUDE.md`, and the autopilot's and automations' `CLAUDE.md` updated. `./singularity build` regenerates the migration, registries and docs.

## Tests

- **`core/`:** `TriageRead` parse (each arm, and that a `done` row missing `priority` throws) and `compareByTriage`.
- **`server/`** (db-test-fixture):
  - The dispatcher respects `concurrency` and drains on a submit.
  - A launch that throws writes `failed`.
  - Submit upserts and overwrites a previous read.
  - A title change that differs from the snapshot marks the read stale; a Haiku re-title to the same text does not.
  - A closed-while-running conversation marks the read failed; a `gone` one does not.
  - The 30-min backstop fails a stuck row.
  - Unapprove does not erase an `excluded`.
  - `pendingApprovalCounts` ignores non-`new` tasks.
- **Autopilot:** port `launch-list.test.ts` and `candidates.test.ts` to priority ranking. Delete `triage.test.ts`.
- **jsdom:** the card renders every state (none, queued, running, done, stale, failed) and Approve toggles without a read.

## Verification

1. `./singularity build`, then `./singularity test plugins/tasks/plugins/task-triage plugins/tasks/plugins/sidequest-autopilot plugins/tasks/plugins/automations`.
2. In the worktree app, open a **main-track** task with the autopilot off. Then:
   - Press Run triage. The card should show Queued, then Running.
   - Press **Conversation ↗**. The read-only agent's conversation should open.
   - Wait for it to submit. The card should fill with Verdict / Priority / Type / Risk.
3. In that conversation (now closed), press Resume and ask "could this be a should instead?". The agent should resubmit, and the card should update live.
4. Try to make the triage agent write a file. The deny list should refuse it.
5. Edit the task title. The card should turn Stale (edited). Press Re-run.
6. Approve an untriaged task. The ✓ should appear. In the task list, filter by Triage = Not triaged, sort by Priority, and group by Type.
7. `query_db`: `select state, priority, task_type from tasks_ext_triage`, and check that `tasks_ext_sidequest_triage` is gone.
8. Screenshot the card in each state with `screenshot.ts --path /tasks/<id>`, and compare against the prototype.

## Out of scope / follow-ups

- **A first-turn contribution seam in `conversations` lifecycle** (preprompt, triage note, and future per-task context), so the note reaches *every* launch and not only the autopilot's.
- Run tasks live in the System category and close as done, so they stay out of the active task views. If they still show up anywhere, hide that category there.
