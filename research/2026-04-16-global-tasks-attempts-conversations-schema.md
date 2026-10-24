# Schema redesign: tasks, attempts, conversations, pushes

## Context

Three entities overlap today, carry duplicated status concepts, and
rely on manual propagation that does not actually happen:

- **`tasks.status`** is user-PATCH-only. Nothing propagates a
  conversation completion into the task. The badge in the UI goes
  stale the moment any conversation does anything interesting.
- **`conversations.status`** is a mash-up. The poller writes
  runtime-ish values (`starting`, `working`, `needs_attention`,
  `gone`) on one path; the push-watcher writes task-outcome values
  (`completed`, `abandoned`) on another. One column, two concerns,
  two writers.
- **`taskAttempts`** exists but is a thin placeholder (id, taskId,
  timestamps). The interesting metadata that logically belongs to an
  attempt — the worktree path, the branch, the push history — is
  scattered across conversations and pushes.
- **`pushes.conversationId`** conflates "the push event" with "the
  specific Claude session that happened to be alive when it
  happened." A future attempt with three collaborating conversations
  (implementer + reviewer + summarizer) would arbitrarily attribute
  the push to whichever conversation ran `./equin push`.

Responsibilities, clean split:

| Entity           | Owns                                                      |
|------------------|-----------------------------------------------------------|
| **Task**         | The goal. Nested. User-intent flag: `cancelled`.           |
| **Attempt**      | One try at the task. Owns worktree + branch. Intent flags: `completedAt`, `abandonedAt`. |
| **Conversation** | One Claude session. Pure runtime state (`phase`). Knows nothing about the task.|
| **Push**         | A git-push event from inside an attempt. Belongs to the attempt.|

Status is derived, not stored, wherever a derivation is well-defined.

Prerequisite: the `pgView` + `dependsOn` primitive from
`2026-04-16-global-derived-state-primitive-v2.md` must land first.
Both are currently unbuilt in the codebase (see Non-goals).

## Target model

```
tasks (0..*) ──owns──> attempts (0..*) ──runs──> conversations (1..*)
                            │
                            └──produced──> pushes (0..*)
```

Hard invariants, enforced by FK `NOT NULL`:

1. Every conversation belongs to exactly one attempt.
2. Every attempt belongs to exactly one task.
3. Every push belongs to exactly one attempt. A conversation FK is
   kept for attribution but nullable.
4. One worktree per attempt. All conversations within an attempt
   share the worktree.

Task nesting (`parentId`) unchanged. Multiple attempts per task is
supported for retries and for future multi-agent compositions on the
same task.

**No orphan conversations.** POST `/api/conversations` without a
`taskId` lazy-creates a placeholder task (`title` synthesised from
the first prompt or literal "Untitled") and an attempt. The user can
rename or re-parent the task afterwards. Every conversation view,
every push, every worktree has a stable owner from the moment it
exists.

## Schema (Drizzle)

Tables and views colocated per the v2 primitive's convention: the
public name is the most-derived form (`tasks`, `attempts`,
`conversations`), the physical table carries a leading underscore
(`_tasks`, `_attempts`). Writers use the underscored name; readers
and cross-plugin consumers import the public name.

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
  cancelled: boolean("cancelled").notNull().default(false),
  expanded: boolean("expanded").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const _attempts = pgTable("attempts", {
  id: text("id").primaryKey(),                       // doubles as worktree dir name
  taskId: text("task_id").notNull().references(() => _tasks.id, { onDelete: "cascade" }),
  worktreePath: text("worktree_path").notNull(),     // absolute fs path
  branch: text("branch").notNull(),                  // git branch name
  completedAt: timestamp("completed_at", { withTimezone: true }),  // intent: delivered
  abandonedAt: timestamp("abandoned_at", { withTimezone: true }),  // intent: given up
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const pushes = pgTable(
  "pushes",
  {
    id: text("id").primaryKey(),
    attemptId: text("attempt_id")
      .notNull()
      .references(() => _attempts.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id"),         // optional attribution, no FK (cross-plugin)
    sha: text("sha").notNull(),
    pushId: text("push_id").notNull(),
    message: text("message").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("pushes_sha_unique").on(t.sha),
    index("pushes_push_id_idx").on(t.pushId),
    index("pushes_attempt_id_idx").on(t.attemptId),
  ],
);

// Public views
export const attempts = pgView("attempts_v").as((qb) =>
  qb.select({
    ...getTableColumns(_attempts),
    state: sql<"pending" | "active" | "completed" | "abandoned">`
      CASE
        WHEN ${_attempts.completedAt} IS NOT NULL THEN 'completed'
        WHEN ${_attempts.abandonedAt} IS NOT NULL THEN 'abandoned'
        WHEN EXISTS (
          SELECT 1 FROM ${conversations} c WHERE c.attempt_id = ${_attempts.id}
        ) THEN 'active'
        ELSE 'pending'
      END
    `.as("state"),
  }).from(_attempts)
);

export const tasks = pgView("tasks_v").as((qb) =>
  qb.select({
    ...getTableColumns(_tasks),
    status: sql<"todo" | "in_progress" | "completed" | "cancelled">`
      CASE
        WHEN ${_tasks.cancelled} THEN 'cancelled'
        WHEN EXISTS (
          SELECT 1 FROM ${_attempts} a
          WHERE a.task_id = ${_tasks.id} AND a.completed_at IS NOT NULL
        ) THEN 'completed'
        WHEN EXISTS (
          SELECT 1 FROM ${_attempts} a
          JOIN ${conversations} c ON c.attempt_id = a.id
          WHERE a.task_id = ${_tasks.id}
            AND c.phase IN ('starting', 'working', 'waiting')
        ) THEN 'in_progress'
        ELSE 'todo'
      END
    `.as("status"),
  }).from(_tasks)
);

export type Task = typeof tasks.$inferSelect;
export type Attempt = typeof attempts.$inferSelect;
export type Push = typeof pushes.$inferSelect;
```

### `plugins/conversations/server/schema.ts`

```ts
import { _attempts } from "@plugins/tasks/server/schema";

export const ConversationPhaseSchema = z.enum([
  "starting",   // process spawning / worktree warming
  "working",    // Claude is computing
  "waiting",    // Claude paused for user / permission prompt
  "gone",       // process dead (any cause)
]);
export type ConversationPhase = z.infer<typeof ConversationPhaseSchema>;

export const _conversations = pgTable("conversations", {
  id: text("id").primaryKey(),
  attemptId: text("attempt_id")
    .notNull()
    .references(() => _attempts.id, { onDelete: "cascade" }),
  title: text("title"),
  phase: text("phase").$type<ConversationPhase>().notNull().default("starting"),
  runtime: text("runtime").notNull().default("tmux"),
  claudeSessionId: text("claude_session_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
});

// Public view: adds `active: boolean` so consumers don't re-derive in TS.
export const conversations = pgView("conversations_v").as((qb) =>
  qb.select({
    ...getTableColumns(_conversations),
    active: sql<boolean>`(${_conversations.phase} <> 'gone')`.as("active"),
  }).from(_conversations)
);

export type Conversation = typeof conversations.$inferSelect;
```

**Removed fields** (vs. today's `conversations` table):

- `worktreePath` → moved to `_attempts.worktreePath`.
- `status` (the mash-up column) → split: runtime part becomes
  `phase`, task-outcome part disappears (lives on the attempt as
  `completedAt` / `abandonedAt`, or on the task as `cancelled`).
- `taskAttemptId` → renamed to `attemptId` and made `NOT NULL`.

**Removed table:** `pushes` (moves to tasks plugin).

## Derivation rules (authoritative)

### `conversations.active`
```
active = phase <> 'gone'
```

### `attempts.state`
```
state =
  'completed'  if completedAt IS NOT NULL
  'abandoned'  if abandonedAt IS NOT NULL
  'active'     if any conversation exists for this attempt
  'pending'    otherwise
```

Note: `active` here is the **lifecycle** state, independent of
whether any individual Claude process is alive right now. An attempt
whose only conversation went `gone` yesterday without a completion
is still `active` (work paused, resumable) — not `stalled` or
`abandoned`. Abandonment is an explicit user signal.

### `tasks.status`
```
status =
  'cancelled'   if cancelled = true
  'completed'   if any attempt has completedAt set
  'in_progress' if any attempt has a conversation with phase ∈ {starting, working, waiting}
  'todo'        otherwise
```

`in_progress` deliberately reads the conversation's live `phase`
rather than the attempt's lifecycle `state`. The task-level badge
reflects *"is something happening right now?"*, not *"has anyone
ever opened an attempt?"*. A task with one `active`-lifecycle
attempt where all conversations are `gone` is back to `todo` — the
work stopped, user needs to resume or cancel.

## Resource graph (`dependsOn`)

```
conversationsResource   (push, loader: SELECT from conversations view)
  ↑ notify: runtime poller on phase change, lifecycle on create/delete

attemptsResource        (push, loader: SELECT from attempts view)
  dependsOn: [conversationsResource]
  ↑ notify: attempt create/delete, completedAt/abandonedAt writes

tasksResource           (push, loader: SELECT from tasks view)
  dependsOn: [attemptsResource, conversationsResource]
  ↑ notify: task create/update/delete

pushesResource          (push, loader: SELECT from pushes)
  dependsOn: [attemptsResource]
  ↑ notify: push-watcher on new row
```

Cascade: any conversation phase change invalidates
`conversationsResource` → `attemptsResource` → `tasksResource` in
one microtask flush. No plugin writes `tasks.status` or
`attempts.state` by hand — these paths do not exist.

`attemptsResource` depending on `conversationsResource` covers
attempt-state transitions driven by "first conversation created" and
the lifecycle "has any conversation" check. Direct notifies on
attempt write-through cover completedAt / abandonedAt.

## Lifecycles

### Conversation creation (POST `/api/conversations`)

Input: `{ taskId?, attemptId?, prompt, runtime? }`.

```
if !attemptId:
  if !taskId:
    taskId = INSERT _tasks { title: synthesiseTitle(prompt), ... }
  attemptId = INSERT _attempts { taskId, worktreePath: newWorktree(), branch, ... }
conversationId = INSERT _conversations { attemptId, phase: 'starting', ... }
spawnRuntime(conversationId, attemptId.worktreePath)
conversationsResource.notify()
```

The "orphan" path collapses to: no taskId, no attemptId → synth a
task + attempt, then continue. One code path, no nullable branches
downstream.

### Conversation phase transitions

The runtime (tmux poller today, agent-SDK later) owns phase writes.
Allowed transitions:

```
starting → working | waiting | gone
working  → waiting | gone
waiting  → working | gone
gone     → (terminal)
```

No path writes `completed`, `abandoned`, or `needs_attention` on
the conversation any more — those concepts moved.

### Attempt completion

A successful `./equin push` that merges into main sets
`_attempts.completedAt` atomically with the `pushes` row insert:

```
// in push-watcher, on detecting a merge push
INSERT pushes (attempt_id, sha, ...)
UPDATE _attempts SET completed_at = now() WHERE id = $attemptId AND completed_at IS NULL
attemptsResource.notify()
pushesResource.notify()
```

First push wins; subsequent pushes add to history but don't mutate
the timestamp. The user can also manually set `completedAt` via a
task/attempt action (out of scope for this doc's exact UX).

### Attempt abandonment

User-set only. UI action → PATCH sets `_attempts.abandonedAt`. No
auto-abandonment from conversation inactivity.

### Task cancellation

User-set only. UI action → `UPDATE _tasks SET cancelled = true`.
Task view flips to `cancelled` immediately.

## Migration plan

Two Drizzle migrations, one hand-written data migration between
them:

### Step 1 — DDL: introduce new structure (generated)

- Add `_attempts.worktreePath`, `_attempts.branch`,
  `_attempts.completedAt`, `_attempts.abandonedAt`.
- Add `_conversations.phase` (text, nullable for now).
- Add `_conversations.attemptId` (nullable for now, FK to _attempts).
- Add `pushes.attemptId`, `pushes.conversationId` nullable.
- Create views `tasks_v`, `attempts_v`, `conversations_v`.

### Step 2 — Data migration (hand-written SQL)

In a new migration file, under the generated DDL:

```sql
-- Backfill attempts from existing conversations.
-- Each existing conversation either has a taskAttemptId or is orphan.
-- Orphans get a fresh placeholder task + attempt. Non-orphans
-- inherit the existing taskAttemptId.

-- 1. Orphan conversations → placeholder task + attempt.
INSERT INTO tasks (id, title, cancelled, expanded, created_at, updated_at)
SELECT 'legacy-orphan-' || c.id,
       COALESCE(c.title, 'Untitled conversation'),
       false, false, c.created_at, c.updated_at
  FROM conversations c
 WHERE c.task_attempt_id IS NULL;

INSERT INTO attempts (id, task_id, worktree_path, branch, created_at, updated_at)
SELECT c.id,                             -- reuse conversation id as attempt id
       'legacy-orphan-' || c.id,
       c.worktree_path,
       'unknown',                        -- backfill branch if not captured today
       c.created_at, c.updated_at
  FROM conversations c
 WHERE c.task_attempt_id IS NULL;

-- 2. Existing taskAttempts rows → backfill worktree from their conversation.
UPDATE attempts a
   SET worktree_path = c.worktree_path,
       branch = 'unknown'
  FROM conversations c
 WHERE c.task_attempt_id = a.id
   AND a.worktree_path IS NULL OR a.worktree_path = '';

-- 3. Point every conversation at its attempt (from step 1 or existing).
UPDATE conversations c
   SET attempt_id = COALESCE(c.task_attempt_id, c.id)
 WHERE c.attempt_id IS NULL;

-- 4. Map old status to new phase.
UPDATE conversations SET phase =
  CASE status
    WHEN 'starting'         THEN 'starting'
    WHEN 'working'          THEN 'working'
    WHEN 'needs_attention'  THEN 'waiting'
    WHEN 'completed'        THEN 'gone'     -- lifecycle concept moves up
    WHEN 'gone'             THEN 'gone'
    WHEN 'abandoned'        THEN 'gone'
  END;

-- 5. For conversations whose old status was 'completed', set the
--    attempt's completedAt so task.status derives correctly.
UPDATE attempts a
   SET completed_at = c.updated_at
  FROM conversations c
 WHERE c.attempt_id = a.id
   AND c.status = 'completed'
   AND a.completed_at IS NULL;

-- 6. Re-key pushes: look up attempt via the conversation they point to.
UPDATE pushes p
   SET attempt_id = c.attempt_id,
       conversation_id = p.conversation_id   -- preserve attribution
  FROM conversations c
 WHERE p.conversation_id = c.id;
```

### Step 3 — DDL: lock down the model (generated)

- Set `_conversations.attemptId` `NOT NULL`.
- Set `_conversations.phase` `NOT NULL`.
- Set `pushes.attemptId` `NOT NULL`.
- Drop `_conversations.worktreePath`.
- Drop `_conversations.status`.
- Drop `_conversations.taskAttemptId`.
- Drop `pushes` FK on `conversationId` (it becomes a soft reference).
- `_tasks`: drop `status`, add `cancelled`.

All three steps land in one `./equin build`. Drizzle-kit
generates steps 1 and 3; step 2 is hand-edited into the generated
migration file before commit (see `server/src/db/migrations/`
existing style).

## Call-site rewrites

Grouped by the exploration report's punch list. All are mechanical
once the schema + resources land.

**Worktree path (conversations → attempts):**
- `plugins/conversations/plugins/conversation-view/plugins/code/server/*file-content-handler.ts` — SELECT `_attempts.worktree_path` via a JOIN on conversation's `attemptId`.
- `plugins/conversations/plugins/conversation-view/plugins/code/server/internal/edited-files-resource.ts` — `worktreePathForSync(conversationId)` becomes `worktreePathForSync(attemptId)` or resolves via the join.
- `plugins/vscode/web/index.ts` — read attempt worktree path.
- `plugins/conversations/server/lifecycle.ts` — worktree creation moves to attempt creation.

**Pushes (conversation → attempt):**
- `plugins/conversations/server/push-watcher.ts` (move → `plugins/tasks/server/push-watcher.ts`) — insert with `attemptId`; also `UPDATE _attempts SET completed_at`. Drop the "did this conversation push?" probe in the poller entirely.
- `plugins/conversations/server/poller.ts` — no longer checks pushes to decide `completed` vs `gone`. Only writes `phase`.

**Status derivation:**
- `plugins/conversations/server/internal/resources.ts` — loader becomes `db.select().from(conversations)` (view). Drop the `.map(r => ({ ...r, active: isActiveStatus(r.status) }))` TS derivation.
- `plugins/tasks/server/internal/resources.ts` — `loader: () => db.select().from(tasks)`, add `dependsOn: [attemptsResource, conversationsResource]`.
- New `plugins/tasks/server/internal/resources.ts` `attemptsResource` — `dependsOn: [conversationsResource]`.
- New `plugins/tasks/server/internal/resources.ts` `pushesResource` — `dependsOn: [attemptsResource]`.

**Handlers:**
- `plugins/conversations/server/handle-create.ts` — lazy-create task + attempt when neither is provided; always produce a non-null `attemptId`.
- `plugins/tasks/server/handle-update.ts` — drop the `status` PATCH branch (status is no longer a column). Replace with `cancelled` toggle handler.
- Add `PATCH /api/attempts/:id` for `abandonedAt`.

**UI:**
- `plugins/conversations/web/conversation-list.tsx` — color from `phase` (+ optional task status lookup for the task-level badge). Drop the `needs_attention`/`completed`/`abandoned` cases; map them to the new taxonomy.
- `plugins/conversations/plugins/conversation-view/plugins/status/web/status-badge.tsx` — reads `phase`.
- Task status badge (anywhere it exists) reads `tasks.status` from the view; automatically correct.

**Gateway / URL routing:**
- Worktree subdomain is now `<attemptId>` instead of `<conversationId>`. For the 1-to-1 legacy case we reuse the conversation id as the attempt id (see migration step 2), so existing URLs keep working for legacy data. New attempts get fresh IDs.

## Plugin boundaries

- **`plugins/tasks`** owns: `_tasks`, `_attempts`, `pushes`, and the
  views `tasks`, `attempts`. Moves `pushes` out of conversations —
  pushes are attempt-level events.
- **`plugins/conversations`** owns: `_conversations`, view
  `conversations`. FKs to `_attempts` (import from
  `@plugins/tasks/server/schema`). Matches the existing cross-plugin
  FK precedent.
- `docs/plugins.md` regenerates to move the `pushes` line and update
  `DB schema` entries.

## Critical files

To modify:

- `plugins/tasks/server/schema.ts` — tables, views, pushes.
- `plugins/conversations/server/schema.ts` — trim to phase + attempt FK.
- `plugins/tasks/server/internal/resources.ts` — add `attemptsResource`, `pushesResource`; add `dependsOn` on `tasksResource`.
- `plugins/conversations/server/internal/resources.ts` — drop TS derivation; add `dependsOn: []` (no upstream for pure runtime state).
- `plugins/conversations/server/handle-create.ts` — lazy-create task + attempt.
- `plugins/tasks/server/handle-update.ts` — drop `status`, add `cancelled` toggle.
- `plugins/conversations/server/poller.ts` — write only `phase`, never outcome.
- `plugins/conversations/server/push-watcher.ts` → `plugins/tasks/server/push-watcher.ts` — re-key pushes + write `completedAt`.
- All worktree-path read sites (4 files in exploration punch list) — JOIN via attempt.
- Generated DDL migrations + one hand-written data migration in `server/src/db/migrations/`.

To create:
- `plugins/tasks/server/handle-attempt-update.ts` — PATCH attempt for `abandonedAt`.

## Verification

End-to-end smoke test after `./equin build`:

1. **Fresh task with attempt and conversation.** POST a task, POST a
   conversation with `taskId`. Observe `tasks.status = 'in_progress'`
   the moment the conversation phase transitions from `starting` to
   `working`. No task-status write anywhere in logs.
2. **Orphan conversation path.** POST `/api/conversations` with no
   taskId. Verify a placeholder task appears in the sidebar, owning
   a single attempt, owning the new conversation. Rename the
   placeholder task; confirm the rest of the hierarchy is intact.
3. **Phase → status cascade.** Kill the tmux pane (`phase` becomes
   `gone`). Observe `tasks.status` drops back to `todo` without any
   explicit write. Use `/api/resources/_debug` to confirm the
   cascade tree fired once per resource.
4. **Push completion.** From inside an agent worktree, run
   `./equin push`. Confirm: `pushes` row with `attemptId`
   populated, `_attempts.completedAt` set, `tasks.status` becomes
   `completed`, no write ever touched `tasks.status` directly.
5. **Cancel a task.** PATCH `cancelled = true`. Observe
   `tasks.status = 'cancelled'` even while attempts/conversations
   remain live. Flip back to `cancelled = false`; status reverts to
   the derived value.
6. **Existing data survives.** Run migration against a DB with
   legacy data; confirm each conversation ends up with an
   `attemptId`, each push ends up with an `attemptId`, no row is
   orphaned, `phase` values are sensible.

## Tradeoffs

- **A third table (`_attempts` elevated to first-class).** Adds one
  row per "try". In practice today attempts and conversations are
  1-to-1, so the cost is one extra JOIN per read and one extra
  INSERT per conversation creation. Negligible — and every plumbing
  decision downstream (multi-agent compositions, worktree sharing,
  push attribution) becomes trivial.
- **Cross-plugin view references.** `tasks_v` joins `conversations`
  across a plugin boundary. Acceptable: the same boundary is already
  crossed by the conversations→taskAttempts FK today. The
  derived-state primitive doc explicitly allows this.
- **Breaking URL change for new attempts.** Old conversations keep
  their ID-as-worktree-name via the migration's reuse trick. New
  attempts use fresh IDs; the worktree subdomain is the attempt's
  ID, not the conversation's. UI components that construct the URL
  need to follow `conversation → attempt → worktree` instead of
  `conversation → worktree`.
- **`attempts.state = active` doesn't imply a live conversation.**
  The task's in_progress check reads conversation phase directly
  rather than trusting attempt state. Two derivations instead of
  one, on purpose: an attempt's lifecycle is long-lived, a task's
  visual status is transient.
- **Migration has a hand-written data step.** Drizzle-kit generates
  DDL; the backfill is one SQL file we edit into the generated
  migration before committing. Standard practice, called out for
  clarity.

## Non-goals

- **Landing the `pgView` + `dependsOn` primitive itself.** That is
  `2026-04-16-global-derived-state-primitive-v2.md` phase 1 and a
  prerequisite for this work. This doc assumes it is in place.
- **Auto-abandonment.** No heuristic marks attempts abandoned based
  on conversation inactivity. The user clicks a button; that sets
  the flag.
- **Parent-task status aggregation.** Whether a parent's status
  summarises its children or stays independent is a separate
  question — leave the derivation narrow for now.
- **Multi-agent role enum on conversations.** Implementer vs
  reviewer vs summarizer is a future extension; add a nullable
  `role` column when the first consumer of it appears.
- **`pgMaterializedView` promotion.** Every view in this doc starts
  at tier A (`pgView`). Promotion is one-token per view when
  measurement demands it.

## Open questions

- **Attempt ID scheme.** Proposal: reuse today's worktree-name
  convention (`claude-<timestamp>`). Keeps gateway routing and `cd`
  habits intact. Alternative: use a separate nanoid and let
  worktreePath be fully decoupled. The reuse is cheaper.
- **Branch column fill for legacy rows.** Step 2 backfills `branch =
  'unknown'` for rows created before the branch was tracked on the
  attempt. Fine for historical, not fine going forward — confirm the
  attempt-creation flow writes a real branch name (it should, since
  the worktree creation already knows it).
- **`conversations.endedAt` — keep or drop?** Today it's written
  when a conversation goes terminal. With `phase = 'gone'` carrying
  the signal, `endedAt` is redundant unless we care about the exact
  moment. Lean: keep for forensic value, write it alongside the
  phase transition to `gone`.
- **Per-params `dependsOn`.** Listed as an open question in the v2
  primitive doc — same applies here for `pushesResource(attemptId)`.
  Not a blocker; current fan-out is fine.
