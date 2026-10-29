# Autonomous run — Mode step (Autonomous tasks, step 3)

Track: wiki page `block-28d79bb7-…` · Design: `block-9fe10dae-…` §6 · Mental model: `block-72c25b90-…` · Previous steps: `research/2026-10-28-tasks-mandate-building-block.md`, `research/2026-10-28-tasks-watcher-report-building-block.md`.

## Context

Mandate, Watcher, Report, stop gate and tree digest are built, but nothing composes them: a user cannot start a run whose root mandate lets agents start sub-work, requires reports and watches what they file, with the root conversation supervising the tree. Nothing keeps the supervisor's context small.

This step adds the **autonomous-run workflow** (the only autonomous-specific code), its **entry point** (an "Autonomous" launch option on the Home prompt and every other new-task composer), and — instead of the planned rollover (user decision, 2026-10-29) — a generic **`compact_context` tool** the agent calls itself.

## Facts the design rests on

- The Home prompt (`agent-manager/welcome` `HomePrompt`) launches through `useTaskLaunch` → `POST /api/tasks/launch` (`tasks/machine/internal/handle-launch-task.ts`): `createTask({… mandate: interactiveMandate()})`, then every launch option's `TaskLaunchServer.apply({taskId, start:"now"}, value)`, then `launchTaskNow`. Its composer renders `<LaunchOptionPills>` from the `TaskLaunch.Option` slot — a new option appears there (and in the task-draft popover, menu-bar card) with no host edit. An option without `useTaskBinding` is draft-only; without `inherit` it is not copied onto filed tasks.
- `setMandate(taskId, policy, tx)` (tasks-core/server) overrides a task's mandate; nearest wins.
- `conversationCreated` (tasks-core) carries `{conversationId, taskId, …}`, emitted in the commit tx.
- `watchTask` / `retargetWatch` / `watchesOf` (`orchestration/watch/server`); a new watch starts with the subtree's current quiet state; quiet ignores the watcher's own conversation.
- `Mcp.instructions({id, render})` sections are frozen at connect (Mandate, Task tree use them).
- `CompactionContext({restore(conversationId)})` (`conversations/compaction-context`) re-hands text after Claude compacts (SessionStart `compact` hook).
- A `/compact <instructions>` turn is supported by the ledger (`acceptTurn`, `pending-turn/landed.ts`); `submitTurn` types a turn into a busy CLI, which runs it after the current turn.

## Plugin layout

```
plugins/tasks/plugins/autonomous-run/            # NEW — the workflow
  core/     autonomousRunOption = defineLaunchOption<{push: PushPolicy} | null>  (default null)
  server/   tasks_ext_autonomous_run (taskId pk, push, createdAt) via entity-extensions;
            TaskLaunchServer apply: row + setMandate(taskId, autonomousMandate(push)); no inherit
  machine/  supervise: Trigger(conversationCreated) → job (root watch)
  web/      TaskLaunch.Option pill "Autonomous" (Off | On, push sub-menu)
plugins/tasks/plugins/mandate-presets/core       # + autonomousMandate(push)
plugins/conversations/plugins/self-compact/      # NEW — generic
  core/     contextCompact = defineCapability<true>("context.compact")
  machine/  compact_context MCP tool, Mandate.Capability describe, StopWaiver
plugins/conversations/plugins/turn-ledger        # + turn kind "compact"
plugins/tasks/machine                            # + CompactionContext: the full task tree
```

`self-compact` names no workflow; `autonomous-run` is a composition of existing calls plus its one marker table.

## 1. The mandate — `autonomousMandate(push)` (mandate-presets)

```ts
mandatePolicy([
  tasksFile.grant({ main: { start: ["now", "after", "manual"] }, sidequest: { start: ["manual"] } }),
  reportRequired.grant(true),
  watchChildren.grant(true),
  pushPolicy.grant(push),          // default "never" (user decision)
  flagRaise.grant(true),
  contextCompact.grant(true),
  // no exitClean: absent = not granted
])
```

No `model` in the grant: filed tasks inherit the filer's launch options as today.

## 2. Starting a run — the launch option

- **Web** (`autonomous-run/web`): `TaskLaunch.Option` with `pill` — label "Autonomous", unset = "Interactive"; menu rows: Interactive, then Autonomous · push Never / If uncontroversial / When checks pass (`PUSH_POLICY_LABELS`). Description: "Agents split the prompt into tasks, start them, and report back; you answer flags and review branches." `startsConversation` not set (it changes nothing about whether the task launches).
- **Server** apply (value non-null): in one tx, insert `tasks_ext_autonomous_run` and `setMandate(taskId, autonomousMandate(push))`. Works the same from the draft popover (a nested task gets its own narrower-or-wider mandate — nearest wins), so no host knob.
- The interactive mandate written by `createTask` is overwritten before `launchTaskNow` — the conversation connects under the autonomous one. (A crash between the two transactions leaves an interactive root that was never launched — the same two-tx stance `handleLaunchTask` documents.)

## 3. The supervisor — whoever runs on the run's root

- `autonomous-run.supervise` job, enqueued by `Trigger({on: conversationCreated})`: if `taskId` has a `tasks_ext_autonomous_run` row, the new conversation becomes the supervisor — `retargetWatch` the root's existing conversation watch, else `watchTask(root, {kind:"conversation", conversationId})`. "Latest conversation on the root supervises" means a relaunch, fork or manual hand-off needs no extra code (and is the future rollover's mechanism).
- Workers filed by the supervisor are watched by it through `watch.children`; the root watch gives it the whole-tree **quiet** event and catches events whose nearer watcher has ended.
- Ending: `report.required` + the stop gate force a final report; the watch waiver lets it end turns while the tree is busy.

## 4. No supervisor prompt (user decision, 2026-10-29)

The workflow ships no supervisor guidance: the user writes the run's prompt themselves (the brief, plus a preprompt picked with the existing Preprompt pill). The only instructions the supervisor receives are the generic ones its mandate grants (`## Mandate`: file with now/after/manual, watch what you file, report, push policy, compact) and the `## Task tree`.

## 5. `compact_context` (conversations/self-compact)

```ts
compact_context({ keep: string, next: string })   // when: granted(contextCompact)
```

- Queues two turns on the caller's own conversation via `submitTurn`: kind `compact`, text `/compact <keep>` (custom summary instructions), then kind `compact`, text `next` (what to continue with). Both run after the current turn ends, in order. Returns "Compaction queued — end your turn now."
- `StopWaiver`: while the conversation has a not-yet-finished `compact` turn, stopping is allowed ("a compaction is queued; you continue after it") — otherwise a supervisor compacting before its tree is busy would be refused by the report gate.
- `Mandate.Capability` describe: "You may compact your own context with `compact_context` after a major step; say what to keep and what to do next."
- Turn kind `compact` added to `TurnKindSchema` (text column, no migration); the pending echo shows "Compacting".
- `tasks/machine` contributes a `CompactionContext` that re-hands the full `taskTree` to any conversation with a `tasks.file` grant, so the tree survives every compaction (agent-requested or automatic).

## Out of scope

- Automatic rollover by context threshold (replaced by `compact_context`; the "latest conversation on the root supervises" rule keeps it possible later).
- A prompt block / page entry point (Dogfood uses the Home prompt with the page link).
- Messaging a worker from the supervisor (it files a follow-up or flags instead).

## Verification

- `./equin test`: `autonomousMandate` grants (no `exit.clean`); launch apply writes row + mandate; supervise job watches the root, retargets on a second conversation, ignores non-run tasks (`db-test-fixture/worktree-db`); `compact_context` queues two ordered turns and is idempotent; waiver decision.
- `./equin build` (migration for `tasks_ext_autonomous_run`, checks: boundaries, cycles, plugins-doc-in-sync).
- On the build: Home prompt shows the Autonomous pill (screenshot); launch one run → `query_db`: root `mandate`, `tasks_ext_autonomous_run`, `task_watches` row for the supervisor; Debug → MCP tools shows `compact_context`, `submit_outcome_report`, no `exit_clean` for it. Event delivery is main-only, so the full loop is the Dogfood step.

## Track page

Update status + checkboxes (Mode done; rollover replaced by `compact_context`), link this doc, file the next main task (Dogfood) with the page id.

## Deviations found at implementation

1. **No `tasks_ext_autonomous_run` table, no autonomous-specific supervise job.** Who supervises is a generic grant: `watch.tree` (watch plugin) — the conversation on the mandate's own root task watches the whole tree; `watch.on-conversation-created` calls `takeOverTreeWatch` (new conversation on the root takes the agent watch over, else a new watch). `autonomous-run` is only the launch option (web pill + server apply `setMandate(autonomousMandate(push))`).
2. **Capabilities in leaf sub-plugins** to break cycles (`conversations → mandate-presets → watch|self-compact → conversations`): `watch/plugins/capabilities` (watch.children, watch.tree) and `self-compact/plugins/capability` (context.compact), the same shape as `outcome-report/plugins/capability`.
3. **`compact_context` does not type turns from the tool call.** A turn typed into a busy CLI is injected at its next tool boundary, where `/compact` would not run as a command. The request is stored (`conversation_compactions`, one per conversation, turn ids minted up front) and `self-compact.send` (Trigger on `conversation.statusChanged`, main-only) types `/compact <keep>` (kind `compact`) + the continuation (`event`) once the agent is idle and not waiting on the user. A pending request waives the stop gate.
4. **No brief re-hand after compaction** (no supervisor prompt); `tasks/machine` re-hands the full task tree to any agent with a `tasks.file` grant.
5. **Launch-option order:** Auto-start, Workspace, Autonomous, Preprompt, Thinking mode (`config/tasks/launch-options/option.jsonc`).

## Known gaps

- `/compact` sent through the SDK runtime and the continuation queued behind it are not checked live (delivery is main-only): first real use is Dogfood.
- `watch.tree`'s describe is read by every agent in the tree, worded as "the agent on the root task…", since a capability's describe does not know who reads it.
6. **No push variants, no `push.policy` grant** (user decision after review): the pill is Interactive (unset, icon only) | Autonomous; how a run pushes is the user's brief or preprompt, not mode instructions. Without a grant, agents follow the repo rule (never push unless told).
7. **Renamed Supervisor; the root is an ordinary conversation** (user decision, 2026-10-29): the option is Interactive | Supervisor (`tasks/supervisor-run`, option id `supervisor`), stating `supervisorMandate()`. Mandate grants gained scopes (`mandatePolicy(grants, { root, below })`, stored as `@root` / `@below`; `grantOf` picks by whether the conversation is on the mandate's own task): the root conversation gets the interactive grants (`push.policy: on-request`, `exit.clean`) plus `watch.tree`, and owes no report; `report.required` covers only the workers below it. One mandate still covers the whole run, so every agent's tree digest stays the run's tree.
