# tasks-core

## The id kinds live in `tasks/task-ids`

`taskIdKind` / `attemptIdKind` / `conversationIdKind` are declared in the leaf
`tasks/task-ids` (so `infra/worktree` can read the attempt kind without a cycle
through this plugin); this plugin mints with them and registers them in both
runtimes' `IdKinds.Kind`.

## Schema layer

The five-table FK cluster (`tasks` self-ref folder/group, `attempts`,
`task_dependencies` composite junction, `pushes`, `conversations`) is defined
through **`defineEntity`** (`infra/entities`) in `server/internal/tables.ts`.
Each table derives from one **field record** in `core/internal/fields.ts`
(`taskFields` / `attemptFields` / `taskDependencyFields` / `pushFields` /
`conversationFields`) — web-safe, built only from the `fields/*/config`
factories (`textField`, `enumTextField`, `boolField`, `dateField`, `rankField`,
`nullable(...)`). FK / cascade / set-null edges, DB defaults, and indexes live in
the entity `meta`, reproducing the previous raw-drizzle DDL byte-for-byte.

The public wire schemas (`TaskSchema` / `AttemptSchema` / `PushSchema` /
`ConversationSchema`, plus `TaskListItemSchema`) live in
`core/internal/schema.ts` and are **derived from the same field records** via
`fieldsToZodObject(<fields>).extend(...)`: the base table columns come from the
field record; the `.extend()` layers the computed *view* columns the derived
pgViews add (`status`, `active`, `finishedAt`, `dependencies`, `worktreePath`,
`taskId`) plus the transform overrides (`rank` → the `Rank` value object,
`model` → the tolerant `StoredModelSchema`, the enum-branded `status` / `kind`).
These schemas describe the VIEW row shapes the live-state resources publish, so
they are intentionally richer than `entity.schema` (the base table row).

**Tree collapse is not a task field.** There is deliberately no `expanded` column:
expand/collapse is per-`(surface, view-instance, row)` device-local render state
owned by the data-view primitive, so a collapse costs no write at all. The column, its
patch field, and the two "auto-expand the parent folder when a child is filed"
blocks in `mutations/tasks.ts` were removed together — the reveal they provided is
now the tree primitive's generic add-child / drag-reparent reveal. Do not
reintroduce it; see `plugins/primitives/plugins/data-view/CLAUDE.md` § State split
and `research/2026-07-28-global-tree-collapse-state-as-view-state.md`.

**`updatedAt` is derived, not written.** On `tasks`, `attempts` and
`conversations` it is maintained by a database trigger from the `touchedBy`
declaration in each entity's meta (`server/internal/tables.ts`) — that
declaration is the single statement of which columns count (e.g. a `clusterId`
relabel, viewing or hibernating a conversation do not). A write to `updatedAt`
raises; never stamp it. Mechanism: `plugins/database/plugins/derived-updated-at`,
design: `research/2026-09-25-global-derived-updated-at.md`.

Keeping the field records + public schemas in `core/` is load-bearing: tasks-core
is web-imported, but `defineEntity` is server-only (`resolveFieldStorage` needs
the `fields.storage` contributions, unregistered in the browser). So
`server/internal/schema.ts` is now a thin shim re-exporting
`core/internal/schema.ts`, and **nothing in `core/` imports anything under
`server/`**.

## I5 — `pushes` is a projection of `main`, not the output of a job

> The `pushes` table covers every trailer-bearing commit reachable from
> `refs/heads/main`. It is re-derived in-process on every observed advance of that
> ref (the **push** half) and before any read that could otherwise observe it
> incomplete (the **pull** half). No queue, no job and no boot hook sits between a
> landed commit and the row that records it.

The ledger owns both halves. It is the same shape `infra/corpus-index` uses for
file-derived indexes — a watcher for freshness, a lazy `ensureFresh` for
correctness — over git instead of the filesystem. Re-deriving it needs git, so it
is split: the pure policy stays in `server/internal/push-ledger/`, the git walk is
the desktop's `machine/internal/push-ledger/`, and the portable code reaches it
through the **`PushLedger` host service** (`server/internal/push-ledger/service.ts`,
`{ ensureFresh() }`): the reads that must see a complete ledger
(`listPushesForAttempt`) and this plugin's `onReady`
catch-up call `PushLedger.get().ensureFresh()`. The desktop provider is
`tasks-core#machine` (the memo below, plus the ref reaction in its `register`);
a host without git provides `plugins/seeded-push-ledger` — nothing to do, the
seeded rows ARE the ledger.

- `read-main.ts` (machine) — the `git log` over `main`'s trailer-bearing commits. DB-free,
  so `read-main.test.ts` exercises it against throwaway repos.
- `walk-bound.ts` — how far back a walk reaches, as pure policy: the earlier of
  the ledger's high-water mark minus a day (catch-up) and 30 days ago (the window
  in which a deferred commit is re-offered).
- `plan.ts` — the pure attribution: which commits this database can attach to an
  attempt and does not already hold, oldest first, plus the ones it had to defer.
- `reconcile.ts` (machine) — the DB-fed orchestration, bounded by a COVERAGE frontier
  (`min(max(pushes.created_at) - 24h, now - 30d)`), so a steady-state run walks a
  month of commits and inserts nothing.
- `attribution.ts` — the in-process generation counter bumped by the one
  conversation-insert funnel, so the freshness signature can see the ledger's
  second input.
- `freshness.ts` (machine) — `ensurePushLedgerFresh()`, one `createSignedMemo` signed on
  `main`'s tip AND the attribution generation. A signature hit costs a string
  compare; a failed reconcile leaves the signature unadvanced so the next call
  retries.
- `raw-reads.ts` — the ungated reads the reconcile itself needs, kept in their own
  file so re-entering the gate from inside a reconcile has no spelling.
- `reaction.ts` (machine) — the push half, a `defineRefReaction` on `refs/heads/main`.

## Status batches ride the transaction

`withTaskStatusBatch` / `runStatusBatchOn(tx, fn)` open a status batch keyed by
the transaction handle itself (`status-batch.ts`, a `WeakMap<DbExecutor,
StatusBatch>`), and `withTaskStatusChange(ids, exec, write)` finds it on the
`exec` it already receives — no ambient context (the batch used to ride an
`AsyncLocalStorage`, a Node-only primitive the portable server may not import).
What that gave up is documented in `status-scope.ts`: a write on ANOTHER
executor while a batch is open used to throw (rung 4); it now finds no batch and
emits for itself. The ambient half of that assertion comes back with the
portable AsyncContext primitive. A batch must join a transaction, never `db`
itself (it would capture every concurrent request's writes) — that throws.

### A deferral is not a skip

A commit whose conversation is absent here is *deferred*, not skipped: it may
become attributable later, because that conversation row can still appear here
(the retired tmux runtime's orphan adoption synthesised such rows). So the walk bound is a **coverage** frontier, not an insertion
one — bounding on `max(pushes.created_at)` alone meant the ledger's own newest row
moved past a deferred commit and no later walk ever reached it again, losing it
permanently. Do not "optimise" the bound back to the watermark, and do not sign
the freshness memo on `main`'s tip alone: this database's conversation set is the
reconcile's second input, which is why the funnel in `mutations/conversations.ts`
bumps `attribution.ts`. Stated policy, not an accident: a commit unattributable
for more than 30 days is treated as foreign.
Design: `research/2026-08-27-tasks-push-ledger-coverage-frontier.md`.

### Why it stopped being a job

The ledger used to be written by a `tasks.push-ingest` job reacting to the durable
`git.refAdvanced` event. Two structural problems, and the second is the one that
mattered:

1. The job reached the work through two hops of the backend's single four-slot
   graphile pool, shared with DB forks, builds and agent spawns. It was observed
   40+ minutes behind a wedged queue.
2. `refAdvanced.emit()` is `isMain()`-gated and the boot reconcile was a
   `scope: "host"` warm-up, so a **worktree** backend had neither an ingest path
   nor a heal path. Its ledger sat frozen at the moment its DB was forked —
   measured at 77 minutes stale with nothing wedged at all.

That is not cosmetic. `task_blocking_v` blocks on
`NOT EXISTS (attempts WHERE status = 'completed')`, and `attempts_v.status` reaches
`completed` only through `attempt_push_agg.has_push` — so an incomplete ledger keeps
dependent tasks blocked and their armed auto-start from ever firing.

### The two invariants compose

I5 is about **completeness**; I3 (`tasks/attempt-work/CLAUDE.md`) is about
**interpretation**. Even a complete ledger cannot see a commit that carries no
trailer (a `--from-main` push), so a row still only ever *proves* a push happened
and its absence still proves nothing. Anything asking "does this attempt have work
at stake?" reads `getAttemptWork`, not this table.

Full design: `research/2026-08-18-global-push-ledger-git-projection.md`.

## I6 — a derived status may claim only what a fact proves

> Every arm of `attempts_v.status` names a fact the row **proves**. A `pushes` row
> may only ever *promote* an attempt to a landed claim (`pushed` / `completed`);
> its absence may never select a claim of its own. With no landed evidence the
> status reports how the **session** ended — `dormant` (a `gone` conversation, so
> the attempt is resumable) or `closed` (every conversation explicitly closed) —
> and says nothing about what did or did not land.

There is deliberately **no `abandoned`**, and no arm that means "nothing landed".
Removing the value is the enforcement: the conclusion has no spelling, so no future
CASE arm or consumer can reach it. If you are about to add one back, the thing you
want is almost certainly `getAttemptWork` (I3) — `has_push IS NULL` conflates *never
pushed*, *finished with nothing to push*, *landed untrailered* and *the ledger has
not caught up*, and it is `false` for every hibernated (`gone`) attempt too.

Consequence: `attempts_v.status` cannot contradict `standingOf` — its only
landed-claiming arm is backed by the same rows `standingOf` ORs into `"landed"`.
The three compose: **I5** completeness, **I3** interpretation, **I6** the derived
status. `views.test.ts` pins the truth table and the coherence assertion.

Full design: `research/2026-08-20-tasks-attempt-status-positive-evidence.md`.

## Live resources

`core/resources.ts` declares every resource this plugin serves (browser-safe, so
readers import the declaration from `tasks-core/core`); `server/internal/resources.ts`
serves them.

- **`taskRows`** (`tasks`) — every task, the WHOLE ordered set
  (`liveCollection(key, { all })`, `rank` then `createdAt`, `preload: "boot"`),
  read with `useLive(taskRows[, { select }])` / `useLiveRow(taskRows, id)`. The
  row is exactly `TaskListItem` (every `tasks_v` column but `description`),
  under the legacy key, so an old-bundle tab subscribing `{}` parses it with its
  own schema (C39, pinned by `tree-oracle.test.ts`); a row change must rename
  the key. Served by `serveCollection` from `server/internal/task-rows.ts` —
  the ONE spelling the server and the tests compile — over the base tables and
  the attempt rollups, never a view: `att` (children over `attempts`, each with
  its two rollup rows), `deps` (the task's own edges → `dependencies`) and
  `blocking` (a closure over `task_dependencies`, each ancestor with its own
  attempts). Costs, pinned per step by the tree oracle: a task write is its own
  row's refill (plus every transitive dependent when it moves `held_at` /
  `dropped_at`); an attempt / conversation / push write its task's and that
  task's dependents'; an edge write the edge's task and its dependents; an
  insert an entrant, a delete an exit; a write no row field reads (a
  conversation's `waiting_for`) nothing.
- **`taskDescriptions`** (`task-descriptions`, lookup-only: `:rows`) — one
  task's `description`, the heavy text the set omits, by id
  (`useLiveRow(taskDescriptions, id)`). A description autosave is that row's
  refill, and also the task's one-row refill in `tasks` (the derived
  `updated_at` moves).
- **The ended-conversation total** is `conversationsGone`'s own `:count`
  (declared `count: true`, preloaded with the window):
  `useLive(conversationsGone, { count: true })`. The collection's own COUNT,
  so it cannot drift from the rows the Done section pages through; its owner
  joins are routed with column gates, so a task or attempt write recounts it
  only when it moves a join key.
- **One definition, two readers.** `server/internal/derived.ts` holds the
  tree's derivations (`attemptDerived`, `taskAttemptAggregates`, `taskDerived`,
  `depIsBlocking`); `views.ts` (`attempts_v`, `task_blocking_v`, `tasks_v`) and
  `task-rows.ts` both interpolate them, and `all-parity.test.ts` holds the
  shipped `tasks` set equal to `tasks_v` row for row. `tasks_v` reads no
  `conversations` and no `pushes`: "waiting" is `attempt_conv_agg.has_waiting_conv`
  and the first push is `attempt_push_agg.min_push_at`.
- **`pushRows`** (`pushes`) is a `liveCollection` over the `pushes` table,
  served with `serveCollection`: `filterable: { attemptId }`, `createdAt` desc,
  100 / 500. Every push surface is attempt-scoped and reads
  `useLive(pushRows, { where: { attemptId } })` — a filter, never a slice of a
  global recent window (that dropped an old attempt's pushes). Named `…Rows`
  because `pushes` is the server table handle.
- **`conversationOwnerJoins` / `conversationOwnerColumns`** (server barrel) are
  the one spelling of a conversation's owners for a routed collection over
  `_conversations`: a required `attempt` lookup on `base.attemptId`, then a
  required `task` lookup on `attempt.taskId` (INNER is lossless — both FKs are
  NOT NULL cascades), binding `worktreePath`, `taskId` and the task's current
  `taskTitle`. Their routes are reverses on each pk: an attempt write resolves
  to its conversations, a task write through `attempts` (never the changed
  `tasks`, A10). The conversation lists (`all-conversations`) serve through
  them; the tree's conversation collections reuse them.
- **`attemptRows`** (`attempts`) — every attempt with its non-system
  conversations (`AttemptWithConversations`), the WHOLE ordered set
  (`createdAt`, `preload: "boot"`), read with `useLive(attemptRows[, { select
  }])` (`web/hooks.ts`' `useTaskAttempts` / `useTaskConversations`). Same
  legacy-key C39 rule as `tasks`. Served from `server/internal/attempt-rows.ts`
  over `attempts`, the two rollups joined row-wise (`attemptDerived`) and a
  children `jsonAgg` of its conversations (`kind <> 'system'`, oldest first;
  `createdAt` crosses as ISO text). Costs: an attempt write its own row; a
  conversation write its attempt's — gated on what the list and the rollup
  read, so `waiting_for` / `last_viewed_at` / `updated_at` reach nothing; a
  push its attempt's (the push rollup's source route — C1: no carrier, no
  FULL); an insert an entrant, a delete an exit.
- **A live loader reads a table, not a view** (C36). `getAttemptRow` is the
  `attempts` row alone; commits-graph and attempt-work (git-work loaders) read
  it, and `listConversationIdsForAttempt` reads `conversations`, so a task or
  conversation write does not recompute them through a view's read-set.
- **The conversation lists** (P8 v3 step 22), served from
  `server/internal/conversation-rows.ts` — the ONE spelling the server and the
  tests compile — over the `conversations` table with
  `conversationOwnerJoins` (never `conversations_v`); every row is the full
  `Conversation` (`active` = `status <> 'done'`):
  - **`conversationsActive`** (`conversations-active`) and
    **`conversationsSystem`** (`conversations-system`) — the WHOLE ordered sets
    of live conversations (`all`, `createdAt` desc, `preload: "boot"`), the
    non-`system` and the `system` ones, read with `useLive(c[, { select }])`.
    Same legacy-key C39 rule as `tasks`. Costs, pinned by the tree oracle: a
    conversation write is its own row's refill (`waiting_for` included — the
    one-row refill a poller tick costs), a close an exit, an insert an
    entrant; a task rename or an attempt move the conversations it owns; any
    other task or attempt write nothing (W4).
  - **`conversationsGone`** (`conversations-gone`) — a WINDOW of the ended
    conversations (`endedAt` desc, default `RECENT_GONE_LIMIT`, `maxLimit`
    500, `count`, `preload: "boot"`; nothing filters it), so it leaves L2:
    the welcome recents read the default, Recovery 50, and the queue's Done
    section pages through it as live key-range pages, its count the
    collection's `:count`.
  - **`conversationsById`** (`conversations.by-id`, lookup-only: `:rows`) —
    any conversation by id, whatever its status or age
    (`useLiveRow(conversationsById, id)`; `conversations/web`'s
    `useConversation` / `useConversationById` and the conversation pane's
    resolver read it). It is what finds a done conversation older than the
    gone window (W9), with no REST fallback.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: tasks-core web presence: eagerly registers the boot-critical tasks / attempts / conversations-* resource descriptors so boot-snapshot can hydrate them before first paint, and owns the client-side reads of them (useTaskAttempts / useTaskConversations, the one join from a task to the attempts and runs it produced). Schema + repository layer for the tasks/attempts/conversations FK cluster.
- Load-bearing: yes
- Web:
  - Contributes:
    - `IdKinds.Kind` "att|claude"
    - `IdKinds.Kind` "conv|claude"
    - `IdKinds.Kind` "task"
  - Uses:
    - `ids.IdKinds`
    - `network/live.useLive`
  - Exports (values):
    - `useTaskAttempts`
    - `useTaskConversations`
- Server:
  - Contributes: 28 contributions — full list in [REFERENCE.md](./REFERENCE.md)
    - `resource.declare` ×18
    - `derived-view` ×4
    - `ids.kind` ×3
    - `derived-table` ×2
    - `host-service:tasks-core.push-ledger` "tasks-core.push-ledger"
  - Uses:
    - `database.db`
    - `database/derived-tables.DerivedTable`
    - `database/derived-views.View`
    - `database/sql-projection.nullable`
    - `database/sql-projection.parsed`
    - `ids.IdKinds`
    - `infra/attachments.Attachments`
    - `infra/entities.defaultNow`
    - `infra/entities.defineEntity`
    - `infra/events.defineTriggerEvent`
    - `network/live.serveCollection`
    - `primitives/rank.nextRankUnder`
    - `primitives/rank.RankExecutor`
    - `primitives/rank.withRank`
  - DB schema:
    - `plugins/tasks/plugins/tasks-core/server/internal/mutations/cross-table.ts`
    - `plugins/tasks/plugins/tasks-core/server/internal/rollup-table.ts`
    - `plugins/tasks/plugins/tasks-core/server/internal/schema-attachments.ts`
    - `plugins/tasks/plugins/tasks-core/server/internal/schema.ts`
    - `plugins/tasks/plugins/tasks-core/server/internal/tables-events.ts`
    - `plugins/tasks/plugins/tasks-core/server/internal/tables.ts`
    - `plugins/tasks/plugins/tasks-core/server/internal/views.ts`
  - Exports (types):
    - `Attempt`
    - `AttemptStatus`
    - `AttemptWithConversations`
    - `Conversation`
    - `ConversationCreatedPayload`
    - `ConversationKind`
    - `ConversationStatusChangedPayload`
    - `ConversationSummary`
    - `CreateAttemptInput`
    - `CreateTaskInput`
    - `DbExecutor`
    - `DropTaskTreeResult`
    - `InsertConversationInput`
    - `InsertPushInput`
    - `OrphanedAttempt`
    - `Push`
    - `PushLandedPayload`
    - `PushLedgerImpl`
    - `Task`
    - `TaskListItem`
    - `TaskStatus`
    - `TaskStatusChangedPayload`
    - `TaskTitleChangedPayload`
    - `UpdateConversationPatch`
    - `UpdateTaskPatch`
  - Exports (values):
    - `_attemptDeliveries`
    - `_attempts`
    - `_conversationCreatedTriggers`
    - `_conversations`
    - `_conversationStatusChangedTriggers`
    - `_pushLandedTriggers`
    - `_tasks`
    - `_taskStatusChangedTriggers`
    - `_taskTitleChangedTriggers`
    - `addTaskDependency`
    - `AttemptSchema`
    - `AttemptStatusSchema`
    - `clusterLabelOf`
    - `conversationAttachments`
    - `conversationCreated`
    - `ConversationKindSchema`
    - `conversationOwnerColumns`
    - `conversationOwnerJoins`
    - `ConversationSchema`
    - `conversationStatusChanged`
    - `createAttempt`
    - `createTask`
    - `deleteAttempt`
    - `deleteConversationRow`
    - `dropTaskIfNoActiveSibling`
    - `dropTaskTreeIfNoActiveSibling`
    - `findNextRankInFolder`
    - `getAttempt`
    - `getAttemptRow`
    - `getConversation`
    - `getConversationClaudeSessionId`
    - `getConversationRuntime`
    - `getTask`
    - `getTaskDependencyIds`
    - `hasAttemptDelivery`
    - `hasBlockingDep`
    - `insertConversation`
    - `insertConversationOnConflictDoNothing`
    - `insertPush`
    - `isDescendant`
    - `listActiveConversations`
    - `listAttempts`
    - `listAttemptsForTask`
    - `listBlockingDepIds`
    - `listConversationIdsForAttempt`
    - `listConversationsForDisplay`
    - `listConversationsForInfra`
    - `listDependentIds`
    - `listHibernationCandidates`
    - `listPushesForAttempt`
    - `listRetainedConversations`
    - `listTasks`
    - `markConversationClosed`
    - `markConversationGone`
    - `orphanedAttemptSink`
    - `pushes`
    - `pushLanded`
    - `PushLedger`
    - `PushSchema`
    - `RECENT_GONE_LIMIT`
    - `recordScratchDelivery`
    - `removeTaskDependency`
    - `setConversationHibernated`
    - `taskAttachments`
    - `taskDependsOn`
    - `TaskListItemSchema`
    - `TaskSchema`
    - `taskStatusChanged`
    - `TaskStatusSchema`
    - `tasksView`
    - `taskTitleChanged`
    - `touchConversationViewed`
    - `unionTaskClusters`
    - `updateConversation`
    - `updateConversationsTitleForTask`
    - `updateTask`
    - `updateTaskTitle`
    - `withTaskStatusBatch`
  - Register:
    - `defineTriggerEvent('pushes.landed')`
    - `defineTriggerEvent('tasks.statusChanged')`
    - `defineTriggerEvent('tasks.titleChanged')`
    - `defineTriggerEvent('conversation.statusChanged')`
    - `defineTriggerEvent('conversation.created')`
  - Resources:
    - `attempt-workspaces:rows` (keyed, point)
    - `attempts` (keyed)
    - `attempts:rows` (keyed, point)
    - `conversations-active` (keyed)
    - `conversations-active:rows` (keyed, point)
    - `conversations-gone` (keyed, window)
    - `conversations-gone:count` (push)
    - `conversations-gone:groups` (push)
    - `conversations-gone:rows` (keyed, point)
    - `conversations-system` (keyed)
    - `conversations-system:rows` (keyed, point)
    - `conversations.by-id:rows` (keyed, point)
    - `pushes` (keyed, window)
    - `pushes:groups` (push)
    - `pushes:rows` (keyed, point)
    - `task-descriptions:rows` (keyed, point)
    - `tasks` (keyed)
    - `tasks:rows` (keyed, point)
- Core:
  - Uses: 22 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `conversations/workspace` ×3
    - `fields/text/config` ×3
    - `fields` ×3
    - `conversations/model-provider` ×2
    - `fields/rank/config` ×2
    - `network/live` ×2
    - `fields/bool/config.boolField`
    - `fields/date/config.dateField`
    - `fields/json/config.jsonField`
    - `fields/string-list/config.stringListField`
    - `infra/entities.entityRef`
    - `primitives/pane.defineRoute`
    - `primitives/rank.RankSchema`
  - Exports (types):
    - `Attempt`
    - `AttemptStatus`
    - `AttemptWithConversations`
    - `Conversation`
    - `ConversationKind`
    - `ConversationStatus`
    - `ConversationSummary`
    - `ConversationWorkingOn`
    - `Push`
    - `Task`
    - `TaskListItem`
    - `TaskNode`
    - `TaskRow`
    - `TaskStatus`
    - `TrailerCommit`
  - Exports (values):
    - `attemptDeliveriesEntityRef`
    - `attemptRows`
    - `AttemptSchema`
    - `attemptsEntityRef`
    - `AttemptStatusSchema`
    - `attemptWorkspaces`
    - `BLOCKED_STATUSES`
    - `buildTaskPrompt`
    - `CONVERSATION_TRAILER_KEY`
    - `ConversationKindSchema`
    - `conversationsActive`
    - `conversationsById`
    - `ConversationSchema`
    - `conversationsEntityRef`
    - `conversationsGone`
    - `conversationsSystem`
    - `ConversationStatusSchema`
    - `ConversationSummarySchema`
    - `ConversationWorkingOnSchema`
    - `isAdoptedConversation`
    - `isBlockedStatus`
    - `isSettled`
    - `parseTrailerLog`
    - `PUSH_TRAILER_KEY`
    - `pushesEntityRef`
    - `pushRows`
    - `PushSchema`
    - `RECENT_GONE_LIMIT`
    - `SETTLED_STATUSES`
    - `TASK_STATUS_OPTIONS`
    - `taskDependenciesEntityRef`
    - `taskDescriptions`
    - `taskDetailRoute`
    - `TaskGraph`
    - `taskRows`
    - `TaskSchema`
    - `tasksEntityRef`
    - `tasksRootRoute`
    - `TaskStatusSchema`
    - `TRAILER_LOG_FORMAT`
- Cross-plugin:
  - Imported by: 71 plugins — full list in [REFERENCE.md](./REFERENCE.md)
    - `conversations` ×30
    - `tasks` ×17
    - `active-data` ×5
    - `debug` ×4
    - `apps` ×3
    - `page` ×3
    - `infra` ×2
    - `stats` ×2
    - `backup/sources/transcripts`
    - `code-explorer`
    - `database/query`
    - `improve`
    - `plugin-meta/plugin-health`
  - Extended by:
    - `conversations/conversation-view/notes` (table `conversations_ext_notes`)
    - `apps/places/ask` (table `conversations_ext_places_ask`)
    - `conversations/conversation-preprompt` (table `conversations_ext_preprompt`)
    - `conversations/conversation-progress` (table `conversations_ext_progress`)
    - `conversations/conversations-view/queue` (table `conversations_ext_queue`)
    - `conversations/runtime-sdk` (table `conversations_ext_sdk_agent`)
    - `conversations/spawn-failure` (table `conversations_ext_spawn_failure`)
    - `conversations/conversation-view/turn-summary` (table `conversations_ext_turn_summary`)
    - `conversations/usage` (table `conversations_ext_usage`)
    - `tasks/auto-start` (table `tasks_ext_auto_start`)
    - `tasks/task-category` (table `tasks_ext_category`)
    - `tasks/task-effort` (table `tasks_ext_effort`)
    - `plugin-meta/plugin-health` (table `tasks_ext_health_review`)
    - `tasks/automations` (table `tasks_ext_launch_decision`)
    - `tasks/automations` (table `tasks_ext_origin`)
    - `tasks/outcome-report` (table `tasks_ext_outcome_report`)
    - `tasks/task-preprompt` (table `tasks_ext_preprompt`)
    - `page/prompt/link` (table `tasks_ext_prompt_block`)
    - `tasks/task-title` (table `tasks_ext_short_title`)
    - `tasks/sidequest-autopilot` (table `tasks_ext_sidequest_triage`)
    - `tasks/task-source-url` (table `tasks_ext_source_url`)
    - `tasks/task-subject` (table `tasks_ext_subject`)
    - `tasks/task-track` (table `tasks_ext_track`)
    - `conversations/workspace/launch-option` (table `tasks_ext_workspace`)
- Exemptions:
  - Exempts itself from:
    - `ids:pk-declared` — `server/internal/tables.ts` (debt)
    - `ids:pk-declared` — `server/internal/tables-events.ts` (debt)
- Machine:
  - Register: `defineRefReaction('tasks.push-ledger (refs/heads/main)')`
- Test helpers:
  - Server: `@plugins/tasks/plugins/tasks-core/server/testing`
    - `canonical` — JSON with sorted keys, so a row compares by content whatever its key order.
    - `createTreeOracle`
    - `installTaskDerivedSchema`
    - `runStatusBatchOn`
    - `TREE_IDS` — The tree workload's ids, for suites interleaving their own statements.
    - `treeSeed` — The seed: five tasks, three edges, two attempts, two conversations, a push.
    - `treeSteps` — The scripted tree writes, in order: every kind of write the app makes to the tree — an insert, a rename, a status flip, an edge added and removed, a drag reorder, an attempt, a conversation and a push landing, a poller write, an attempt moved between tasks, cascade deletes of an attempt and a task, a drop.
    - `withSteps` — The script with a suite's own steps spliced in: each `after[label]` runs right after the step of that label (an unknown label throws, so a renamed step cannot silently drop a suite's case).
    - Types: `TreeLoad`, `TreeOracle`, `TreeOracleOptions`, `TreeStep`, `TreeStepCost`
- Sub-plugins:
  - **`seeded-push-ledger`** (excluded) — The push ledger of a host without git: provides the PushLedger host service as nothing to do — there is no main history to project, so the `pushes` rows the database was seeded with ARE the ledger…

<!-- AUTOGENERATED:END -->
