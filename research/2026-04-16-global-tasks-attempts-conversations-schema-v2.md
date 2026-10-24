# Schema redesign v2: tasks, attempts, conversations, pushes

Supersedes `2026-04-16-global-tasks-attempts-conversations-schema.md`.

## What changed from v1

- **Dropped the `branch` column on `_attempts`.** A worktree *has* a
  branch; the worktree path is the attempt's identity. Storing the
  branch name alongside is duplication.
- **No stored intent flags on attempts.** v1 had
  `_attempts.completedAt` / `_attempts.abandonedAt`. v2 derives the
  attempt's status purely from `pushes` rows and conversation
  statuses. The `pushes` table is already the source of truth for
  "delivered"; no reason to shadow it with a timestamp.
- **Task drop becomes a timestamp, not a boolean.** `_tasks.cancelled`
  (bool) → `_tasks.dropped_at` (nullable timestamp). Single source of
  truth for both "is it dropped" and "when was it dropped". The name
  changes from `cancelled` to `dropped` per the user's preference
  (drop can also mean *superseded* or *obsolete*, not just cancelled).
- **Every entity gains a derived `active` boolean.** Consistency: one
  shared mental model of "is this thing in a terminal state or not."
- **Task status vocabulary:** `new | in_progress | attempted | done |
  dropped`.
- **Attempt status vocabulary:** `pending | in_progress | pushed |
  completed | abandoned`. (The word `dropped` is reserved for the
  task-level user action to avoid overloading one term across two
  different mechanisms.)
- **Conversation status vocabulary** (renamed from `phase` back to
  `status` for consistency across the three entities): `starting |
  working | waiting | gone`.
- **Added an explicit status reference table** (§Status reference).
- **View derivations use a CTE for predicates.** `attempts` and
  `tasks` each define an `*_facts` CTE that computes the
  `has_conv / has_live_conv / has_push` (attempts) or
  `has_attempt / has_completed / has_active` (tasks) predicates once
  per row, then reference them by name in `status`, `active`, and
  `finished_at`. The SQL now reads like the pseudocode in
  §Derivation rules, and changing the logic is a one-place edit.

The rest of v1 (orphan policy, no-null FKs, pushes move to tasks
plugin, plugin boundaries, pgView + dependsOn primitive as
prerequisite) is unchanged. This doc only restates those sections
where the change matters.

## Context (brief)

Same as v1: tasks/attempts/conversations have overlapping status
concepts with manual propagation that does not happen. Conversation
status mashes runtime liveness with task outcome. Pushes
mis-attribute to whichever conversation ran the push. Task status
goes stale because nothing writes it. Fix by giving each entity one
responsibility and deriving the rest.

## Entity responsibilities

| Entity           | Owns                                                      |
|------------------|-----------------------------------------------------------|
| **Task**         | The goal. Nested. Stored drop timestamp.                  |
| **Attempt**      | One try at the task. Owns the worktree path.              |
| **Conversation** | One Claude session. Owns Claude runtime status.           |
| **Push**         | A git-push event from inside an attempt.                  |

## Status reference

Single overview of every status/active/time field — stored vs
derived, and what each derivation depends on.

| Entity       | Field         | Values                                                              | Stored? | Derivation                                                                 |
|--------------|---------------|---------------------------------------------------------------------|---------|----------------------------------------------------------------------------|
| Task         | `status`      | `new` · `in_progress` · `attempted` · `done` · `dropped`            | derived | from `_tasks.dropped_at` + aggregates over `attempts`                      |
| Task         | `active`      | `true` / `false`                                                    | derived | `status = 'in_progress'`                                                   |
| Task         | `finished_at` | timestamp or `null`                                                 | derived | `dropped_at` if dropped; `min(push.created_at)` if done; else `null`       |
| Task         | `dropped_at`  | timestamp or `null`                                                 | stored  | user action (drop button)                                                  |
| Attempt      | `status`      | `pending` · `in_progress` · `pushed` · `completed` · `abandoned`    | derived | from existence of `pushes` rows + conversation statuses                    |
| Attempt      | `active`      | `true` / `false`                                                    | derived | `status ∈ {pending, in_progress, pushed}`                                  |
| Attempt      | `finished_at` | timestamp or `null`                                                 | derived | `min(push.created_at)` if completed; `max(conv.ended_at)` if abandoned; else `null` |
| Attempt      | `worktree_path` | absolute fs path                                                 | stored  | set at attempt creation                                                     |
| Conversation | `status`      | `starting` · `working` · `waiting` · `gone`                         | stored  | runtime adapter writes on tmux poll / agent SDK event                      |
| Conversation | `active`      | `true` / `false`                                                    | derived | `status <> 'gone'`                                                          |
| Conversation | `ended_at`    | timestamp or `null`                                                 | stored  | written alongside the transition to `gone`                                 |
| Push         | `created_at`  | timestamp                                                           | stored  | push-watcher on merge detection                                             |

**Ground-truth columns** — the only writers any code ever targets:

1. `_conversations.status` — the runtime adapter (tmux poller today,
   agent SDK next).
2. `_conversations.ended_at` — written alongside the transition to
   `gone`.
3. `_tasks.dropped_at` — user action only.
4. `pushes` row insert — push-watcher only.
5. `_tasks` / `_attempts` / `_conversations` CRUD — handlers on
   create/delete.

Everything else is a `pgView`.

## Derivation rules

### Conversations

```
active = (status <> 'gone')
```

### Attempts

Define three boolean predicates per attempt `a`:

```
has_conv      = EXISTS conversation c where c.attempt_id = a.id
has_live_conv = EXISTS conversation c where c.attempt_id = a.id AND c.status <> 'gone'
has_push      = EXISTS push p          where p.attempt_id = a.id
```

Status:

```
status =
  'pending'      if NOT has_conv
  'in_progress'  if has_live_conv AND NOT has_push
  'pushed'       if has_live_conv AND has_push
  'completed'    if has_conv AND NOT has_live_conv AND has_push
  'abandoned'    if has_conv AND NOT has_live_conv AND NOT has_push
```

Active:

```
active = (NOT has_conv) OR has_live_conv
       = (status ∈ {pending, in_progress, pushed})
```

Finished:

```
finished_at =
  MIN(pushes.created_at)                  if status = 'completed'
  MAX(conversations.ended_at)             if status = 'abandoned'
  NULL                                    otherwise
```

`abandoned` is **auto**-derived ("all conversations went gone with
no push"). The task-level equivalent — the user explicitly dropping
the task — uses the different word `dropped` so the two mechanisms
never collide in the UI.

### Tasks

Define three boolean predicates per task `t`:

```
has_attempt           = EXISTS attempt a         where a.task_id = t.id
has_completed_attempt = EXISTS attempt a         where a.task_id = t.id AND a.status = 'completed'
has_active_attempt    = EXISTS attempt a         where a.task_id = t.id AND a.active
```

Status (ordered — first match wins):

```
status =
  'dropped'      if t.dropped_at IS NOT NULL          -- user intent wins
  'done'         if has_completed_attempt
  'in_progress'  if has_active_attempt
  'attempted'    if has_attempt
  'new'          otherwise
```

Active:

```
active = (status = 'in_progress')
```

Finished:

```
finished_at =
  t.dropped_at                            if status = 'dropped'
  MIN(p.created_at  across pushes of completed attempts of t)
                                          if status = 'done'
  NULL                                    otherwise
```

Note: `attempted` means every attempt terminated without a push and
the user hasn't declared the task done — the work stalled but isn't
explicitly dropped. The task hangs around in this state until the
user either spawns a new attempt (`in_progress`), marks the task
dropped (`dropped`), or a future attempt delivers (`done`).

## Schema (Drizzle)

### `plugins/tasks/server/schema.ts`

```ts
// Physical tables
export const _tasks = pgTable("tasks", {
  id: text("id").primaryKey(),
  parentId: text("parent_id").references((): AnyPgColumn => _tasks.id, {
    onDelete: "cascade",
  }),
  title: text("title").notNull(),
  description: text("description"),
  droppedAt: timestamp("dropped_at", { withTimezone: true }),  // user drop
  expanded: boolean("expanded").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const _attempts = pgTable("attempts", {
  id: text("id").primaryKey(),                        // doubles as worktree dir name
  taskId: text("task_id").notNull().references(() => _tasks.id, { onDelete: "cascade" }),
  worktreePath: text("worktree_path").notNull(),      // absolute fs path
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const pushes = pgTable("pushes", {
  id: text("id").primaryKey(),
  attemptId: text("attempt_id").notNull().references(() => _attempts.id, { onDelete: "cascade" }),
  conversationId: text("conversation_id"),            // optional attribution (soft ref)
  sha: text("sha").notNull(),
  pushId: text("push_id").notNull(),
  message: text("message").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex("pushes_sha_unique").on(t.sha),
  index("pushes_push_id_idx").on(t.pushId),
  index("pushes_attempt_id_idx").on(t.attemptId),
]);

// Public views — both use a CTE to DRY the predicates.

export const attempts = pgView("attempts_v").as((qb) => {
  // Predicates per attempt, computed once.
  const facts = qb.$with("attempt_facts").as(
    qb.select({
      id: _attempts.id,
      hasConv: sql<boolean>`EXISTS (
        SELECT 1 FROM ${_conversations} c WHERE c.attempt_id = ${_attempts.id}
      )`.as("has_conv"),
      hasLiveConv: sql<boolean>`EXISTS (
        SELECT 1 FROM ${_conversations} c
         WHERE c.attempt_id = ${_attempts.id} AND c.status <> 'gone'
      )`.as("has_live_conv"),
      hasPush: sql<boolean>`EXISTS (
        SELECT 1 FROM ${pushes} p WHERE p.attempt_id = ${_attempts.id}
      )`.as("has_push"),
      minPushAt: sql<Date | null>`(
        SELECT MIN(p.created_at) FROM ${pushes} p WHERE p.attempt_id = ${_attempts.id}
      )`.as("min_push_at"),
      maxEndedAt: sql<Date | null>`(
        SELECT MAX(c.ended_at) FROM ${_conversations} c WHERE c.attempt_id = ${_attempts.id}
      )`.as("max_ended_at"),
    }).from(_attempts)
  );

  return qb.with(facts).select({
    ...getTableColumns(_attempts),
    status: sql<"pending" | "in_progress" | "pushed" | "completed" | "abandoned">`
      CASE
        WHEN NOT ${facts.hasConv}                                      THEN 'pending'
        WHEN ${facts.hasLiveConv} AND NOT ${facts.hasPush}              THEN 'in_progress'
        WHEN ${facts.hasLiveConv} AND ${facts.hasPush}                  THEN 'pushed'
        WHEN ${facts.hasPush}                                           THEN 'completed'
        ELSE                                                                 'abandoned'
      END
    `.as("status"),
    active: sql<boolean>`(NOT ${facts.hasConv}) OR ${facts.hasLiveConv}`.as("active"),
    finishedAt: sql<Date | null>`
      CASE
        WHEN ${facts.hasPush} AND NOT ${facts.hasLiveConv}              THEN ${facts.minPushAt}
        WHEN ${facts.hasConv} AND NOT ${facts.hasLiveConv}
          AND NOT ${facts.hasPush}                                      THEN ${facts.maxEndedAt}
        ELSE                                                                 NULL
      END
    `.as("finished_at"),
  })
  .from(_attempts)
  .innerJoin(facts, eq(facts.id, _attempts.id));
});

export const tasks = pgView("tasks_v").as((qb) => {
  // Predicates per task, computed once. Reads the `attempts` view so
  // the derivation rides the same `status` / `active` definitions.
  const facts = qb.$with("task_facts").as(
    qb.select({
      id: _tasks.id,
      hasAttempt: sql<boolean>`EXISTS (
        SELECT 1 FROM ${_attempts} a WHERE a.task_id = ${_tasks.id}
      )`.as("has_attempt"),
      hasCompleted: sql<boolean>`EXISTS (
        SELECT 1 FROM ${attempts} a
         WHERE a.task_id = ${_tasks.id} AND a.status = 'completed'
      )`.as("has_completed"),
      hasActive: sql<boolean>`EXISTS (
        SELECT 1 FROM ${attempts} a
         WHERE a.task_id = ${_tasks.id} AND a.active
      )`.as("has_active"),
      minCompletedPushAt: sql<Date | null>`(
        SELECT MIN(p.created_at)
          FROM ${pushes} p
          JOIN ${_attempts} a ON a.id = p.attempt_id
         WHERE a.task_id = ${_tasks.id}
      )`.as("min_completed_push_at"),
    }).from(_tasks)
  );

  return qb.with(facts).select({
    ...getTableColumns(_tasks),
    status: sql<"new" | "in_progress" | "attempted" | "done" | "dropped">`
      CASE
        WHEN ${_tasks.droppedAt} IS NOT NULL  THEN 'dropped'
        WHEN ${facts.hasCompleted}             THEN 'done'
        WHEN ${facts.hasActive}                THEN 'in_progress'
        WHEN ${facts.hasAttempt}               THEN 'attempted'
        ELSE                                        'new'
      END
    `.as("status"),
    active: sql<boolean>`
      ${_tasks.droppedAt} IS NULL
      AND NOT ${facts.hasCompleted}
      AND ${facts.hasActive}
    `.as("active"),
    finishedAt: sql<Date | null>`
      CASE
        WHEN ${_tasks.droppedAt} IS NOT NULL  THEN ${_tasks.droppedAt}
        WHEN ${facts.hasCompleted}             THEN ${facts.minCompletedPushAt}
        ELSE                                        NULL
      END
    `.as("finished_at"),
  })
  .from(_tasks)
  .innerJoin(facts, eq(facts.id, _tasks.id));
});
```

### `plugins/conversations/server/schema.ts`

```ts
import { _attempts } from "@plugins/tasks/server/schema";

export const ConversationStatusSchema = z.enum([
  "starting",   // process spawning / worktree warming
  "working",    // Claude is computing
  "waiting",    // Claude paused for user / permission prompt
  "gone",       // process dead (any cause)
]);
export type ConversationStatus = z.infer<typeof ConversationStatusSchema>;

export const _conversations = pgTable("conversations", {
  id: text("id").primaryKey(),
  attemptId: text("attempt_id")
    .notNull()
    .references(() => _attempts.id, { onDelete: "cascade" }),
  title: text("title"),
  status: text("status").$type<ConversationStatus>().notNull().default("starting"),
  runtime: text("runtime").notNull().default("tmux"),
  claudeSessionId: text("claude_session_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
});

export const conversations = pgView("conversations_v").as((qb) =>
  qb.select({
    ...getTableColumns(_conversations),
    active: sql<boolean>`(${_conversations.status} <> 'gone')`.as("active"),
  }).from(_conversations)
);
```

**Removed vs. today's `conversations`:**

- `worktreePath` → `_attempts.worktreePath`.
- Old `status` mash-up enum (`starting|working|needs_attention|completed|gone|abandoned`) → trimmed to `starting|working|waiting|gone`.
- `taskAttemptId` → `attemptId`, `NOT NULL`.
- `pushes` table → moved to tasks plugin.

## Resource graph (`dependsOn`)

```
conversationsResource   (push; loader: SELECT from conversations view)
  ↑ notify: runtime poller on status change; handlers on create/delete.

attemptsResource        (push; loader: SELECT from attempts view)
  dependsOn: [conversationsResource, pushesResource]
  ↑ notify: attempt create/delete.

tasksResource           (push; loader: SELECT from tasks view)
  dependsOn: [attemptsResource]
  ↑ notify: task create/update/delete.

pushesResource          (push; loader: SELECT from pushes)
  ↑ notify: push-watcher on new row.
```

Cascade coverage:

- Conversation status change → `conversationsResource.notify()` →
  cascades to `attemptsResource` → `tasksResource`. Badges update
  across the hierarchy in one tick.
- Push insert → `pushesResource.notify()` → `attemptsResource` →
  `tasksResource`. Attempt flips `in_progress` → `pushed`, task
  becomes `done` once conversations go gone.
- Task drop (PATCH sets `dropped_at`) → `tasksResource.notify()`
  directly.

No code anywhere writes derived columns. The five ground-truth write
sites listed in §Status reference are the entire mutation surface.

## Lifecycles

### Conversation creation (POST `/api/conversations`)

Input: `{ taskId?, attemptId?, prompt, runtime? }`.

```
if !attemptId:
  if !taskId:
    taskId = INSERT _tasks { title: synthesiseTitle(prompt), ... }
  attemptId = INSERT _attempts { taskId, worktreePath: newWorktree(), ... }
conversationId = INSERT _conversations { attemptId, status: 'starting', ... }
spawnRuntime(conversationId, _attempts.worktreePath)
conversationsResource.notify()
```

The orphan path collapses into "synthesise task + attempt, then
continue." Every downstream query can assume `attemptId` is set and
the attempt's worktree path is available.

### Conversation status transitions (runtime-owned)

```
starting → working | waiting | gone
working  → waiting | gone
waiting  → working | gone
gone     → (terminal; set ended_at simultaneously)
```

No writer other than the runtime adapter ever touches
`_conversations.status`. No path writes "completed", "abandoned" or
"needs_attention" any more.

### Attempt completion (no write)

There is no write. Completion happens because the push-watcher
inserts a `pushes` row for the attempt **and** the attempt's last
conversation reaches `gone`. The attempts view returns
`status='completed'` the moment both hold. Task badge updates via
the cascade.

If a user wants to mark an attempt done while conversations are
still live, the path is "stop the conversations" (their status goes
to `gone`), and if there's a push the attempt flips to `completed`.
There's no manual "attempt done" button — there doesn't need to be.

### Task drop (user action)

`PATCH /api/tasks/:id { drop: true }` → `UPDATE _tasks SET dropped_at
= now()`. `PATCH { drop: false }` → `UPDATE _tasks SET dropped_at =
NULL`. The task view flips immediately.

## Migration plan

Two generated DDL migrations, one hand-written data migration
between them. Landed in one `./equin build`.

### Step 1 — DDL: introduce new structure

- Add `_attempts.worktree_path` (nullable for now).
- Add `_conversations.attempt_id` (nullable for now, FK `_attempts`).
- Add `pushes.attempt_id` (nullable for now).
- Create views `tasks_v`, `attempts_v`, `conversations_v`.

Note: old `_tasks.status`, `_conversations.status` (wide enum),
`_conversations.worktree_path`, `_conversations.task_attempt_id`,
`pushes.conversation_id` FK all stay in place for the duration of
step 2.

### Step 2 — Data migration (hand-written SQL)

```sql
-- 1. Orphan conversations → placeholder task + attempt.
INSERT INTO tasks (id, title, expanded, created_at, updated_at)
SELECT 'legacy-' || c.id,
       COALESCE(c.title, 'Untitled conversation'),
       false, c.created_at, c.updated_at
  FROM conversations c
 WHERE c.task_attempt_id IS NULL;

INSERT INTO attempts (id, task_id, worktree_path, created_at, updated_at)
SELECT c.id,                            -- reuse conversation id as attempt id
       'legacy-' || c.id,
       c.worktree_path,
       c.created_at, c.updated_at
  FROM conversations c
 WHERE c.task_attempt_id IS NULL;

-- 2. Existing taskAttempts rows: backfill worktree from their conversation.
UPDATE attempts a
   SET worktree_path = c.worktree_path
  FROM conversations c
 WHERE c.task_attempt_id = a.id
   AND (a.worktree_path IS NULL OR a.worktree_path = '');

-- 3. Point every conversation at its attempt.
UPDATE conversations
   SET attempt_id = COALESCE(task_attempt_id, id);

-- 4. Map old conversation.status → new 4-value status.
UPDATE conversations SET status =
  CASE status
    WHEN 'starting'         THEN 'starting'
    WHEN 'working'          THEN 'working'
    WHEN 'needs_attention'  THEN 'waiting'
    WHEN 'completed'        THEN 'gone'
    WHEN 'gone'             THEN 'gone'
    WHEN 'abandoned'        THEN 'gone'
  END;

-- 5. Re-key pushes via conversation.
UPDATE pushes p
   SET attempt_id = c.attempt_id
  FROM conversations c
 WHERE p.conversation_id = c.id;

-- 6. Historical: conversations whose old status = 'completed' but
--    that never produced a push row end up derived as 'abandoned'
--    at the attempt level. Acceptable loss of fidelity — these are
--    rare legacy rows, and the user can re-drop/re-complete manually.
```

### Step 3 — DDL: lock down the model

- `_conversations.attempt_id` `NOT NULL`.
- `pushes.attempt_id` `NOT NULL`.
- Drop `_conversations.worktree_path`.
- Drop `_conversations.task_attempt_id` (FK replaced by `attempt_id`).
- Drop `pushes.conversation_id` FK (keep column as soft attribution).
- Drop `_tasks.status`.

No `completedAt` / `abandonedAt` / `branch` to add or drop — they
were never in v1's final DDL in production.

## Call-site rewrites

Same as v1 §Call-site rewrites, minus anything referencing
`completedAt`, `abandonedAt`, `cancelled`, or `branch`. The relevant
deltas:

- **Push-watcher:** inserts `pushes` row with `attemptId`. No more
  `UPDATE _attempts SET completed_at` (derivation does it).
- **Handler:** `PATCH /api/tasks/:id` handles `drop: boolean` →
  writes `dropped_at` timestamp (or nulls it). No `status` PATCH.
- **Handler:** no `PATCH /api/attempts/:id` for
  `abandonedAt` — drop the concept; attempt terminals are derived.
- **Runtime adapter** (poller): writes only `status` and `endedAt`.
  The "was there a push?" probe that decided `completed` vs `gone`
  today is deleted; it only ever wrote `gone` now.
- **UI task-status badge:** colors mapped to the new 5-value task
  status. `new` = gray, `in_progress` = blue, `done` = green,
  `attempted` = amber, `dropped` = strike-through / muted.
- **UI conversation-status badge:** 4-value status. `needs_attention`
  badge becomes `waiting`.

## Verification

1. **Fresh task cascade.** Create task; POST conversation; observe
   task goes `new → in_progress` as conversation status hits
   `working`. No write to task status anywhere in logs.
2. **Orphan collapse.** POST conversation with no taskId; observe
   placeholder task + attempt appear; rename the task; confirm
   hierarchy survives.
3. **Push flow (simulated).** Do **not** run `./equin push` —
   that promotes a branch to main and must never be invoked for
   testing. Instead, simulate the push by inserting a `pushes` row
   directly (SQL, or a dedicated test helper). Observe:
   - Attempt status flips to `pushed` (conversation still alive).
   - Flip the attempt's sole conversation to `gone`; attempt
     becomes `completed` and task becomes `done`.
   - `attempts.finished_at` = inserted push row's `created_at`;
     `tasks.finished_at` matches; no stored timestamp was written.
   The full push-watcher → merge path is covered by its own
   integration test in the push plugin, not by this verification
   plan.
4. **Abandon flow.** Kill tmux pane without pushing. Observe
   conversation → `gone`, attempt → `abandoned` (auto), task →
   `attempted`. Spawn another conversation on the same task;
   observe task → `in_progress` again.
5. **User drop.** PATCH `drop: true` on a task; observe `status =
   dropped` and `finished_at = dropped_at` regardless of live
   attempts. PATCH `drop: false`; status reverts to derived.
6. **Cascade hygiene.** Via `/api/resources/_debug`, confirm a
   single conversation-status change triggers exactly one reload per
   downstream resource.

## Tradeoffs

- **Attempt view is view-of-view over `attempts`.** The tasks view
  reads `attempts` (a view) rather than `_attempts` (the table), so
  it rides the already-derived `status` / `active` columns. Postgres
  will usually inline; worst-case promote either view to
  `pgMaterializedView` with a one-token change.
- **Predicates isolated in a CTE.** Each view computes its `*_facts`
  CTE once per row of the target table, then references the columns
  by name in every CASE. If the predicate logic ever changes, the
  edit happens in one place. No copy-paste drift between `status`,
  `active`, and `finished_at`.
- **No "user marks attempt done" button.** The model says "push +
  conversations gone = completed." If you want to mark an attempt
  complete without a push, the UX is to stop the conversation and
  accept `abandoned`, or to synthesise a push. Matches the intent:
  "done" means "code shipped." Simpler model; slight UX rigidity.
- **`attempted` is a weak state.** A task where every attempt
  stalled without a push or drop ends up here. It's not terminal
  and not active. The UI should probably surface this as "stalled —
  retry or drop?" so users don't leave tasks stuck.
- **No stored `completedAt` means push time is the finished time.**
  If the push happened before the last conversation went gone,
  `attempt.finished_at` is still the push's `created_at` (not when
  the last conversation ended). Matches what users mean by "finished
  at": the moment it shipped.
- **Historical fidelity loss in migration.** Legacy conversations
  marked `completed` without a push row will derive as `abandoned`
  attempts. Rare and harmless.

## Non-goals

Unchanged from v1. Summary: not landing the primitive itself, no
auto-abandonment writer (`abandoned` attempts are auto-derived but
that's derivation-time, not a stored transition), no parent-task
status aggregation, no multi-agent role enum yet, no
materialized-view promotion at first pass.

## Open questions

- **Attempt ID scheme.** Reuse today's `claude-<timestamp>` naming
  (keeps gateway routing seamless) vs fresh nanoid. Lean reuse.
- **Task finished time for `attempted` state.** Currently `null` —
  the last conversation's ended_at across all attempts could fill
  this, but `attempted` isn't a finished state, so `null` is
  probably correct.
- **Fallback `'invalid'` in the attempt CASE.** The five-branch
  enumeration is exhaustive given the three predicates, so no
  `else` is possible. Adding an explicit `else 'invalid'` guard
  gives a louder failure signal if the taxonomy ever grows. Cheap;
  worth it.
- **Do we keep `conversations.ended_at`?** Yes — it's used by
  `attempts.finished_at` for the abandoned case. Also mildly useful
  for forensic display ("this conversation ran for 12 minutes").
