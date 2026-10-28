# Watcher + Report building blocks (Autonomous tasks, step 2)

Track: wiki page `block-28d79bb7-…` · Design: `block-9fe10dae-…` §3, §4 · Mental model: `block-72c25b90-…` · Previous step: `research/2026-10-28-tasks-mandate-building-block.md`.

## Context

Mandate (step 1) states what an agent may do. Several things are still missing:

- Nothing tells a watching agent or loop what happened in the subtree.
- A worker's report, flag or completion wakes nobody.
- Events that arrive while the watcher is busy are not merged into one turn.
- `flag_raise` is a no-op.
- `outcome-report` is gated on "is this an automation" and calls `releaseLaunchedTask` in automations directly.
- Nothing stops an agent from ending its work without a report.

This step adds:

- **Watch** (`tasks/orchestration/watch`):
  - Sources are contributed by the plugins that own the facts.
  - An event is routed to the nearest live watcher.
  - The plugin detects when a subtree goes quiet.
  - Events are delivered as one `event` turn, or as a batch to a code handler.
- **Report generalized:** a `report.required` mandate capability, and an event when a report is submitted.
- **`flag_raise`** records the flag and emits an event.
- **A generic `conversations/stop-gate`.**

## Deviations from the Design page (forced by import cycles or found while reading the code)

1. **`started` / `created` / `settled` sources are contributed by `tasks`, not `conversations`.**
   - Both events (`conversation.created`, `tasks.statusChanged`) are declared in `tasks-core`.
   - `watch/server` must import `conversations/server` (for `submitTurn`), so `conversations` cannot contribute to `watch` without a cycle.
   - `tasks` owns task semantics and sits above both.
2. **The tree digest's per-line words become a contribution, `TreeDigest.Annotation`.** Today the caller passes `annotate`.
   - `watch` renders a digest in every event turn but cannot import `tasks`, which owns the track/armed words.
   - `tasks` contributes track + armed/manual. `outcome-report` contributes `report: <first sentence>`, which closes the "report column" left open in step 1.
3. **Quiet is re-evaluated on `conversation.statusChanged` and `tasks.statusChanged` as well, not only after routing an event.**
   - A worker reports while it is still `working`. The subtree only becomes quiet when that conversation stops, and stopping emits no watched event.
   - Quiet is evaluated for every live watch on the ancestor chain, not only the nearest. A deep leaf stopping can make the root quiet.
   - Quiet is still delivered only to the watch it concerns, never bubbled.
4. **The automations slot release moves onto a code watcher now, not in the later Migrate step.**
   - Dropping `releaseLaunchedTask` from `outcome-report` would otherwise stop launch slots being freed.
   - `runLaunch` creates `watchTask(task, {kind:"code", handler:"automations.slot", key:automationId})`. The handler calls `releaseLaunchedTask` on `reported`.
   - The `automations.task-status` job stays. Deleting it is the Migrate step.
5. **Every automation mandate grants `report.required`**, so behaviour is unchanged: all four automations' agents report today through `automationOfTask`. The interactive preset grants neither `report.required` nor `watch.children`, so interactive conversations are unchanged.
6. **`watch.children` is `true` only, with no `"on-request"` value.** "On request" would need a `watch_task` tool that nothing needs yet. A missing grant means no watching.
7. **An event turn never answers a pending question.**
   - `submitTurn` routes a turn to a conversation waiting on `QUESTION_WAITING_FOR` into `answerPrompt`, which dismisses the question.
   - So delivery also waits while `waitingFor` is set. The status trigger re-runs delivery once the user answers.

## Plugin layout

```
plugins/tasks/plugins/orchestration/plugins/watch/
  core/     watchChildren capability (defineCapability<true>, "watch.children"); WatchEvent types
  server/   tables (task_watches, watch_inbox), watchTask / endWatch / retargetWatch,
            watchSource(...) helper, WatchSource + WatchHandler contributions,
            watch.ingest / watch.deliver / watch.quiet jobs, Triggers, stop waiver,
            Mandate.Capability describe for watch.children
plugins/conversations/plugins/stop-gate/
  core/     endpoint contract GET /api/conversations/:id/stop-gate → {decision, reason}
  server/   StopGate + StopWaiver contributions, handler
  machine/  stopGateHookEntry() (resolves bin path, like compaction-context)
  bin/      stop-gate.ts (Stop hook: reads EQUIN_CONVERSATION_ID / PARENT_HOST, fails open)
plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/event-turn/   # renders an event turn as a system card
```

`orchestration/CLAUDE.md` rule: no workflow or track named here. The watch plugin declares its own capability, `watch.children`, the same way `tasks` owns `tasks.file`. It names nobody else's.

Import DAG check:
- `watch` → `tasks-core`, `mandate`, `tree-digest`, `conversations/server`, `events`, `jobs`, `stop-gate`.
- Contributors → `watch`: `tasks/machine`, `outcome-report`, `push-and-exit`, `automations`.
- `conversations` imports none of these.

## 1. Watch (`orchestration/watch`)

**Tables** (`server/internal/tables.ts`, plain pgTable):

```ts
task_watches (id, task_id → tasks cascade, watcher jsonb  // {kind:"conversation", conversationId} | {kind:"code", handler, key}
              , watcher_conversation_id → conversations cascade (nullable, denormalized for the live check / FK),
              quiet boolean default false, created_at, ended_at)
watch_inbox  (id, watch_id → task_watches cascade, kind text, task_id, actor_conversation_id null,
              summary text, payload jsonb, created_at, delivered_in_turn text null)   index (watch_id) where delivered_in_turn is null
```

**Server API:**
- `watchTask(taskId, watcher, tx?)` is idempotent per (task, watcher).
- `endWatch(id)` and `retargetWatch(id, conversationId)`.
- `watchesOf(conversationId)` is used by the waiver.

**Sources.**
- The helper `watchSource({ id, on: EventSource<P>, toEvents(p) => WatchEventInput[] })` returns `[WatchSource({id,toEvents}), Trigger({ on, do: watchIngestJob, with:{source:id}, oneShot:false })]`. A contributor spreads it like `...served.declare`, so a source can never be declared without its trigger.
- `WatchEventInput` is `{ kind, taskId, actorConversationId?, summary, payload? }`. `kind` is an open string.

**Routing** (`watch.ingest`, `hold:"instant"`, `dedup:"none"`):
1. `toEvents(event)`.
2. For each event, `nearestLiveWatch(taskId, excludeOwner: actorConversationId)`. This is a recursive CTE modelled on `nearestMandate` (`tasks-core/server/internal/queries/tasks.ts:35`), joined to `task_watches`.
   - A watch is live when `ended_at` is null and its conversation exists and is not `done`.
3. Insert into the inbox and enqueue `watch.deliver` (`dedup:{key: watchId}`) in the same tx.
4. No live watch means the event is dropped. Ancestors learn of it through the digest.

**Quiet** (`watch.quiet`, `dedup:{key: watchId}`).
- Enqueued for every live watch on the ancestor chain of the task by two triggers:
  - `tasks.statusChanged`
  - `conversation.statusChanged`, when the conversation leaves a busy state (`isAgentBusy`).
- Not quiet means one of these holds:
  - a descendant-or-self task has a conversation in `starting` or `working`, other than the watcher's own;
  - an armed task (`tasks_ext_auto_start` row) is not blocked (`task_blocking_v`).
- On a false → true transition of `task_watches.quiet`, insert a `quiet` inbox row and enqueue deliver. Going true → false only flips the column.

**Delivery** (`watch.deliver`, keyed by watch, `isMain()` guard as in `auto-start-jobs.ts:236`):
- **Conversation watcher:**
  - The watcher is not live (`done`): re-route its undelivered rows to the next live ancestor watch.
  - The watcher is `starting` or `working`, or `waitingFor` is set: return. A Trigger on `conversation.statusChanged` re-enqueues deliver for that conversation's watches.
  - Otherwise, in one tx:
    - Claim the undelivered rows. `turnId` is a hash of the row ids, set as `delivered_in_turn`.
    - Render one turn: one line per event (kind · task id · title · summary; the full report body for `reported`), then `treeDigest(...)`.
    - Call `submitTurn(conversationId, {id: turnId, kind:"event", …})`. It is idempotent on `turnId` and resumes a hibernated conversation itself.
- **Code watcher:** `WatchHandler.getContributions()` looks up the handler by id and calls `onEvents(batch, {watch})`. The rows are claimed in the same tx before the call. Any error rethrows (fail loudly, job retry).

**Stop waiver.** `StopWaiver`: the conversation owns a live watch whose `quiet` is false. The reason is "you will be woken by the next event in task X's subtree".

**Capability.** `watch.children: true`.
- Its describe text says that tasks you file are watched by you, and their reports and flags arrive as turns.
- `tasks/machine` `add_task` calls `watchTask(newTask, {kind:"conversation", conversationId})` after filing when `grantOf(watchChildren)` is non-null.

## 2. Turn kind `event` (`conversations/turn-ledger` + transcript)

- Add `"event"` to `TurnKindSchema` (`turn-ledger/core/schemas.ts:15`). The column is text, so no migration is needed.
- Envelope: for kind `event`, `submitTurn` wraps `typedText` in `<equin-event>…</equin-event>`. The helper is in turn-ledger core, so a caller cannot forget it.
- `transcript-source` `parse-jsonl.ts` recognizes the envelope next to `<task-notification>` and emits an `event-turn` transcript event, not `user-text`. `userPromptText` returns null for it, so a rewind cannot cut there.
- A jsonl-viewer sub-plugin `event-turn` registers `JsonlViewer.EventRenderer({match:"event-turn"})`. It draws a compact system card (the event lines, the digest collapsed).
- `pending-turn` keeps working by kind: the echo shows "Event" while it is in flight.

## 3. Report (`tasks/outcome-report`)

- New `reportRequired = defineCapability<true>({id:"report.required"})` in a core leaf, `outcome-report/plugins/capability/core`. Automations import it for their mandates without a cycle, the same pattern as the `push-and-exit/plugins/capabilities` leaf.
- `Mandate.Capability({cap: reportRequired, describe})`. The describe absorbs today's `outcomeReportInstructions` text, and the separate instructions section is deleted.
- The tool's `when` becomes `granted(reportRequired)`, and `isAutomationConversation` is deleted.
- The tool **drops `releaseLaunchedTask`**. After the upsert it emits a new `outcomeReport.submitted` trigger event, `{taskId, conversationId, standing, hasQuestion, question}`, in `server/internal/tables-events.ts`.
- The `watchSource("outcome-report", on: outcomeReportSubmitted)` source produces `reported`, or `asking` when there is a question. The summary is the body.
- `StopGate`: block when `report.required` is granted to the conversation and the task has no `tasks_ext_outcome_report` row whose `conversationId` is this one. The reason names `submit_outcome_report`.
- `TreeDigest.Annotation`: `report: <first sentence>`.
- After this, `outcome-report` imports nothing from automations. The `Automations.TaskDetail` web contribution stays: that is the dependency direction automations exposes, not a call into it.

## 4. `flag_raise` (`push-and-exit`)

- Table `conversation_flags (id, conversation_id, task_id, reason, created_at)`.
- Trigger event `conversation.flagRaised {conversationId, taskId, reason}`.
- The handler uses `ctx.conversationId` and writes the row and the emit in one tx.
- Source `watchSource("flag", …)` → kind `flagged`, summary = reason.
- The inline tool-call rendering stays. A review queue is a later step.

## 5. Stop gate (`conversations/stop-gate`)

- Contributions:
  - `StopGate({id, check(conversationId) → {kind:"allow"} | {kind:"block", reason}})`
  - `StopWaiver({id, waives(conversationId) → string | null})`
- Decision rule:
  - If any gate blocks and no waiver waives, the decision is `block`, with the reasons joined.
  - A waiver adds its reason as `allow`, for logging.
- Endpoint `GET /api/conversations/:id/stop-gate`, via `defineEndpoint` + `implement()`.
- `bin/stop-gate.ts` is modelled on `compaction-context/bin` + `shared/client.ts`: node builtins only, reads `EQUIN_CONVERSATION_ID` / `EQUIN_PARENT_HOST`.
  - It honours `stop_hook_active`: allow, so there is one forced continuation per stop attempt and never an infinite loop.
  - On a block it prints `{decision:"block", reason}`.
  - On a transport error it fails open: it writes to stderr and exits 0.
- Wiring:
  - `agentLaunchPolicy({compaction, stopGate})` (`agent-launch/server/internal/launch-settings.ts:55`) adds `Stop: [{hooks:[stopGate]}]`, with a collision assert like `SessionStart`.
  - `sdk-runtime.ts:464` passes `stopGateHookEntry()`.
- Only app-launched agents get it. The repo `.claude/settings.json` is untouched.

## 6. Code watcher for automations (slot release)

- `automations/server`: `WatchHandler({ id:"automations.slot", onEvents })` → `releaseLaunchedTask(taskId)` on `reported`, which already calls `wake()`.
- `runLaunch` (`define.ts:186`, next to `setMandate`) adds `watchTask(pick.taskId, {kind:"code", handler:"automations.slot", key: automationId})`.
- The mandates of the 4 automations (autopilot, reports-investigation, upstream, deps updates) add `reportRequired.grant(true)`.

## Tree-digest refactor

- `treeDigest` / `taskTree` stop taking `annotate`. They read `TreeDigest.Annotation({ id, annotate(tasks) → Map<id,string[]> })` contributions.
- `tasks/machine/internal/tree-digest.ts` moves its annotate into a contribution.

## Out of scope (next steps)

- `autonomous-run` (Mode step): it will create the supervisor watch on the root.
- Supervisor rollover (`retargetWatch` exists but has no caller yet).
- Deleting `automations.task-status`.
- Debug → Mandates watches screen.
- A report that is stale after later events is not re-required (v1: any report by this conversation satisfies the gate).

## Verification

- `./equin test` on watch, outcome-report, stop-gate, tree-digest, tasks, and the automations parts, using the `database/db-test-fixture/worktree-db` harness for routing. Cases:
  - nearest-live routing, skipping an ended or done watcher and the actor's own watch
  - re-route on a dead watcher
  - quiet transition, evaluated once per transition, excluding the watcher's own conversation and armed-but-blocked tasks
  - deliver claims a batch of N rows into ONE turn, and is idempotent on `turnId` across a retry
  - deliver is held while busy or `waitingFor`
  - the stop-gate decision table
  - the parser recognizes `<equin-event>`
- `./equin build`: migrations, checks (boundaries, cycles, `table-defs-in-schema-glob`, plugins-doc-in-sync).
- On the build:
  - Debug → MCP tools: `submit_outcome_report` is hidden for an interactive conversation.
  - `query_db`: `task_watches`, `watch_inbox`, `conversation_flags` exist; the triggers are registered in `*_triggers`.
- Delivery to a live conversation is `isMain()`-gated, like auto-start, so the end-to-end "two reports → one event turn" check runs in the jsonl-viewer exhibit and the unit tests. The live run on main is the Dogfood step.

## Track page

When done:
- Update the status and the Watcher / Report / `flag_raise` checkboxes.
- List the deviations above.
- File the next main task, "Mode: autonomous run", with the page id and the Track Instructions pointer.

## Deviations found at implementation

1. **Watch is split into `server` and `machine`.** The demo browser composition boots `watch/server`, so that barrel must stay portable (`browser-host:contributions-covered`).
   - `server` keeps the tables, the API, the contribution kinds, the routing, quiet and delivery policy (`deliverOn`, which takes ports), and the waiver.
   - `machine` keeps `watchSource()`, the jobs and the capability describe. Contributors import `watchSource` from `watch/machine`, and `push-and-exit` gained a `machine/` folder for its source.
2. **`tasks.created` is a new trigger event** in tasks-core, emitted from `createTaskOn`. No existing event marks a creation together with its author.
3. **The new tables use declared id kinds** (`watch`, `wevt`, `cflag`), because `ids:pk-declared` requires it. The new trigger tables are listed as debt in their plugins' `exempt/`, like tasks-core's own.
4. **Quiet also re-evaluates when an agent becomes busy**, so the true → false flip is recorded and a second quiet is not missed. A new watch starts with the subtree's current quiet state, so filing a manual task does not wake the filer at once.
5. **Placement of `report.required`:** the capability leaf is `outcome-report/plugins/capability/core`, and the describe, gate, stop gate, source and digest annotation are in `outcome-report/machine`. `automationOfTask` is deleted.
6. **The automations slot handler also releases on `asking`** (a report with a question), as the tool did before, and only for the launched task's own report. Afterwards it ends its watch.
7. **The event envelope is applied in `acceptTurn`** (turn-ledger store), the single entry point for every turn. `submitTurn` callers pass the raw body.

## Known gaps

- **Launches made before this deploy** have neither a `report.required` grant nor a slot watch. Their slot is released when the task settles (`automations.task-status`, which is unchanged), not when they report.
- **Events routed in one transaction share `created_at`**, so their order inside one turn is by id, not by causality.
- **Clearing `waitingFor` without a status change** does not re-run delivery. Held events wait for the next status change.
- **`retargetWatch` has no caller yet** (supervisor rollover, Mode step).
- **Event turns are invisible to the outline, rewind and agent-thread grouping**, which only know `user-text`.
