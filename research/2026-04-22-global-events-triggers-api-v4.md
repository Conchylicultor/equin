# Events & Triggers API — v4 (per-event-type tables)

> Supersedes [v3](./2026-04-22-global-events-triggers-api-v3.md). v4 keeps v3's minimal-API spirit but flips the storage model: instead of one polymorphic `_triggers` table with a generic `match_value`, every event type gets **its own table** with typed columns and real foreign keys to its domain (e.g. `_task_completed_triggers.task_id REFERENCES tasks(id) ON DELETE CASCADE`). Cron is one such table, owned by the events plugin.

## Context

v3 made one table do double duty for cron and event triggers, with a single nullable `match_value TEXT` column for the latter. That design had three soft spots that compound as the system grows:

1. **Leaky cleanup.** Cleanup of triggers whose target was deleted required every owning plugin to remember `DELETE FROM _triggers WHERE action_config->>'agentId' = ...` in its delete handler. Storage internals leak into every consumer.
2. **Single-key matching only.** "When task X completes *and* it's owned by agent Y" had no clean expression. Escape hatches (`'X:Y'` strings, post-fetch filtering in actions) were ugly.
3. **Type safety stops at the API edge.** `match_value TEXT` and `action_config JSONB` are unchecked at the storage layer. Renaming a key in `action_config` silently breaks subscribers.

v4's bet is that the per-event-type-table cost (one migration per new event type) is smaller than these costs, given equin's automatic migration pipeline (`./equin build`) and small plugin count.

## What changes from v3

| v3 | v4 | Why |
|---|---|---|
| One `_triggers` table with `kind: 'event'\|'cron'` discriminator | One table per event type; cron is one such table | Real typed columns + FK constraints |
| `match_value TEXT` | Per-table typed columns (e.g. `task_id`, `conversation_id`, `spawned_by`) | Multi-key matching is just normal SQL |
| Each plugin owns its own delete-cleanup code | `ON DELETE CASCADE` on the FK does the cleanup | One line in the table def replaces N delete handlers |
| `defineEventType<T>(name, key)` — single-key generic | `defineEventType<T>({ name, table, match })` returning a def with an `emit(payload)` method | Table-bound def, multi-key match query; emit-as-method matches `resource.notify()` style |
| Separate `createTrigger({ kind: 'event', ... })` API | Plain `db.insert(table).values(...)` from each owning plugin | One less abstraction; tables are first-class Drizzle |
| `oneShot` boolean column | Same — kept; uniform across event-trigger tables | Convention bakes it in |
| Compound (`all`/`any`) triggers | Still deferred (unchanged) | — |
| Ephemeral `event.on` / `event.once` | Still removed (v3 was right) | `resources.notify()` covers UI reactivity; inline code covers same-process reactions |

## Storage model

### Where tables live

A trigger table that FKs to e.g. `_tasks` **must live in the same plugin as `_tasks`**. The codebase's `tables.ts` files are load-order leaves — they cannot import another plugin's tables (see comment at [`plugins/tasks-core/server/internal/tables.ts:13`](../plugins/tasks-core/server/internal/tables.ts) and the existing precedent of `_conversations` co-located with `_attempts` and `_tasks` for the same reason).

Concrete placement:

| Table | FK to | Lives in |
|---|---|---|
| `_cron_triggers` | (none) | `plugins/events/server/internal/tables.ts` |
| `_task_completed_triggers` | `_tasks(id)` | `plugins/tasks-core/server/internal/tables.ts` |
| `_conversation_completed_triggers` | `_conversations(id)` | `plugins/tasks-core/server/internal/tables.ts` |
| `_agent_<event>_triggers` (future) | `_agents(id)` | `plugins/agents/server/internal/tables.ts` |

The events plugin doesn't own per-event tables; it owns the **registry**, **dispatcher**, **cron scheduler**, and a column-shorthand helper. Each owning plugin owns its tables and exports `EventTypeDef`s through its `server/api.ts`.

### Common column shorthand

Every event-trigger table shares a fixed set of columns. The events plugin exports a helper so each table just spreads them:

```ts
// plugins/events/server/api.ts
import { boolean, jsonb, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const eventTriggerColumns = () => ({
  id: uuid("id").primaryKey().defaultRandom(),
  actionName: text("action_name").notNull(),
  actionConfig: jsonb("action_config").$type<Record<string, unknown>>().notNull(),
  enabled: boolean("enabled").notNull().default(true),
  oneShot: boolean("one_shot").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
```

A concrete event-trigger table is then a few lines:

```ts
// plugins/tasks-core/server/internal/tables.ts (new addition)
import { eventTriggerColumns } from "@plugins/infra/plugins/events/server/api";

export const _taskCompletedTriggers = pgTable(
  "task_completed_triggers",
  {
    ...eventTriggerColumns(),
    taskId: text("task_id").references(() => _tasks.id, { onDelete: "cascade" }),
    // taskId NULL = match-any; otherwise match this specific task only.
  },
  (t) => [index("task_completed_triggers_task_id_idx").on(t.taskId).where(sql`enabled`)],
);

export const _conversationCompletedTriggers = pgTable(
  "conversation_completed_triggers",
  {
    ...eventTriggerColumns(),
    conversationId: text("conversation_id").references(() => _conversations.id, { onDelete: "cascade" }),
    spawnedBy: text("spawned_by"),
    // both NULL = match-any; either filters narrow the match.
  },
  (t) => [
    index("conv_completed_triggers_conv_id_idx").on(t.conversationId).where(sql`enabled`),
    index("conv_completed_triggers_spawned_by_idx").on(t.spawnedBy).where(sql`enabled`),
  ],
);
```

### Cron table (events plugin)

```ts
// plugins/events/server/internal/tables.ts
export const _cronTriggers = pgTable(
  "cron_triggers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cronExpr: text("cron_expr").notNull(),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    actionName: text("action_name").notNull(),
    actionConfig: jsonb("action_config").$type<Record<string, unknown>>().notNull(),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("cron_triggers_due_idx").on(t.nextRunAt).where(sql`enabled`)],
);
```

Cron is intentionally not under `eventTriggerColumns()` — it has no `oneShot` (cron reschedules itself) and adds `cronExpr` / `nextRunAt` / `lastRunAt`. It's the one table the events plugin owns directly because nothing else owns "wall-clock" as a domain.

## API — three primitives

```ts
// plugins/events/server/api.ts

// 1. Declare an event type. Bound to a backing table and a match-query
//    function. `emit` is a method on the returned def — same shape as
//    `defineResource(...).notify()` elsewhere in the codebase.
export interface EventType<T> {
  name: string;
  table: PgTable;
  match: (payload: T) => SQL;
  emit(payload: T): Promise<void>;
}

export function defineEventType<T>(def: {
  name: string;
  table: PgTable;
  match: (payload: T) => SQL;
}): EventType<T> {
  return {
    ...def,
    async emit(payload: T): Promise<void> {
      const rows = await db.select().from(def.table).where(and(
        eq(def.table.enabled, true),   // every event-trigger table has this column
        def.match(payload),
      ));
      await Promise.all(rows.map((row) => runAction(row, payload, def.table)));
    },
  };
}

// 2. Register a named action handler. In-memory map populated at module load.
type ActionHandler<C = any> = (config: C, ctx: ActionContext) => Promise<void> | void;
const actions = new Map<string, ActionHandler>();
export function registerAction<C>(name: string, run: ActionHandler<C>): void {
  actions.set(name, run as ActionHandler);
}

export interface ActionContext {
  payload: unknown;       // null for cron
  triggerId: string;      // the row that fired
  table: PgTable;         // for one-shot deletes by the dispatcher
}
```

`runAction` looks up `row.actionName` in the in-memory registry, calls it with `row.actionConfig` and the `ActionContext`, then if `row.oneShot` deletes the row from `event.table`. Errors are logged and swallowed (no retries — separate design).

**Asymmetry note.** `emit` lives on the event def (`taskCompleted.emit(...)`) because each event is a typed, named, plugin-owned object — same shape as `recentConversationsResource.notify()`. `registerAction` and `createCronTrigger` stay as free functions because actions are flat string-keyed registrations (consumers reference them by string in `action_config`, not by importing a def) and cron isn't per-event-type — there's no def to attach it to.

For cron specifically, the events plugin exports one helper because creating a cron trigger requires computing `next_run_at`:

```ts
export async function createCronTrigger(spec: {
  cronExpr: string;
  action: string;
  config: object;
}): Promise<string> {
  const nextRunAt = parseCron(spec.cronExpr).next().toDate();
  const [row] = await db.insert(_cronTriggers).values({
    cronExpr: spec.cronExpr,
    nextRunAt,
    actionName: spec.action,
    actionConfig: spec.config as Record<string, unknown>,
  }).returning({ id: _cronTriggers.id });
  return row.id;
}
```

For event triggers, callers just `INSERT` into the relevant table directly — no `createTrigger` wrapper, because Drizzle's `db.insert(table).values({...})` is already the primitive and per-table validation is best done by the owning plugin.

## Defining and emitting an event — concrete

The `tasks-core` plugin owns both the trigger tables and the `EventTypeDef`s for events that target tasks/conversations:

```ts
// plugins/tasks-core/server/api.ts
import { defineEventType, registerAction } from "@plugins/infra/plugins/events/server/api";
import { _taskCompletedTriggers, _conversationCompletedTriggers } from "./internal/tables";

export interface TaskCompletedPayload { taskId: string; parentId: string | null; status: "success" | "failure"; }

export const taskCompleted = defineEventType<TaskCompletedPayload>({
  name: "tasks.completed",
  table: _taskCompletedTriggers,
  match: (p) => or(
    isNull(_taskCompletedTriggers.taskId),
    eq(_taskCompletedTriggers.taskId, p.taskId),
  )!,
});

export interface ConversationCompletedPayload { conversationId: string; spawnedBy: string | null; }

export const conversationCompleted = defineEventType<ConversationCompletedPayload>({
  name: "conversations.completed",
  table: _conversationCompletedTriggers,
  match: (p) => and(
    or(isNull(_conversationCompletedTriggers.conversationId),
       eq(_conversationCompletedTriggers.conversationId, p.conversationId)),
    or(isNull(_conversationCompletedTriggers.spawnedBy),
       eq(_conversationCompletedTriggers.spawnedBy, p.spawnedBy ?? "")),
  )!,
});

// Action that the queued-child trigger uses
registerAction<{ taskId: string; prompt?: string }>("tasks.launch", async (cfg) => {
  await createConversation({ taskId: cfg.taskId, prompt: cfg.prompt ?? "" });
});
```

The agents plugin registers its own action:

```ts
// plugins/agents/server/api.ts
import { registerAction } from "@plugins/infra/plugins/events/server/api";
import { handleLaunch } from "./internal/handle-launch";

registerAction<{ agentId: string; prompt?: string }>("agents.launch", async (cfg) => {
  await handleLaunch(cfg.agentId, { prompt: cfg.prompt });
});
```

## Dispatch — same two wake-ups as v3

### Path A — `emit()` (event triggers)

One SQL query per emit. Each event's `match` function generates a WHERE clause that references its own typed columns. Because every event type has its own table, queries never touch rows from other event types.

```sql
-- Generated for taskCompleted.emit({ taskId: 'X', ... }):
SELECT * FROM task_completed_triggers
 WHERE enabled AND (task_id IS NULL OR task_id = 'X')
```

Hits the partial index on `task_id WHERE enabled`. O(matches).

### Path B — cron scheduler (`setInterval`)

Identical to v3. Single `setInterval(tickOnce, 5_000)` started from the events plugin's `onReady`. Modeled on the existing [`plugins/tasks/server/internal/push-watcher.ts:131`](../plugins/tasks/server/internal/push-watcher.ts) pattern (see also [`plugins/conversations/server/internal/poller.ts:129`](../plugins/conversations/server/internal/poller.ts)).

```sql
SELECT * FROM cron_triggers
 WHERE enabled AND next_run_at <= now()
 ORDER BY next_run_at LIMIT 100 FOR UPDATE SKIP LOCKED
```

Advance `next_run_at = parseCron(expr).next()`, update `last_run_at = now()`, run the action. `cron-parser` returns "next from now", so a long downtime fires once on resume — not N replays.

## Emit-site discipline

The plugin that owns the state mutates a row and emits in the same function. Same contract as `resources.notify()`. Concrete sites:

- **`conversationCompleted`** — emit from [`plugins/conversations/server/internal/poller.ts:92`](../plugins/conversations/server/internal/poller.ts) right after `await updateConversation(id, { status: "gone", endedAt: new Date() })`. Conversation `status` is a real column ([`plugins/tasks-core/server/internal/tables.ts:103`](../plugins/tasks-core/server/internal/tables.ts)) so the transition site is unambiguous.
- **`taskCompleted`** — task "doneness" is **derived** in the `tasks_v` view from the presence of completed attempts ([`plugins/tasks-core/server/internal/schema.ts:117-128`](../plugins/tasks-core/server/internal/schema.ts)). There is no single column flip. The emit must fire from each write that *causes* the derived status to flip to done — pragmatically, that is `insertPush` (push completes attempt → task derived as done) in [`plugins/tasks-core/server/internal/mutations/pushes.ts`](../plugins/tasks-core/server/internal/mutations/pushes.ts), and `updateTask({ drop: true })` in [`plugins/tasks-core/server/internal/mutations/tasks.ts:53`](../plugins/tasks-core/server/internal/mutations/tasks.ts) if "dropped" should count. Each emitter must re-derive the task's status post-write and only emit on a `not-done → done` transition. (If this gets gnarly, the alternative is adding an explicit `completedAt` column to `_tasks` and emitting from its setter — out of scope for this doc, but worth flagging.)

If a future code path mutates a row outside the plugin's API and skips the emit, no event fires. That's a caller bug, not a framework gap — exactly the same contract as `resource.notify()`.

## End-to-end flows

### Flow 1 — cron launches an agent

```
User configures agent A with cron '0 9 * * *'.
 ↓ agents plugin's PATCH handler:
    await createCronTrigger({
      cronExpr: '0 9 * * *',
      action: 'agents.launch',
      config: { agentId: A.id },
    })
 ↓ events plugin: INSERT INTO cron_triggers (..., next_run_at = next 9am)

[9:00 next morning, scheduler tick]
 ↓ SELECT FOR UPDATE SKIP LOCKED on cron_triggers WHERE next_run_at <= now()
 ↓ UPDATE cron_triggers SET next_run_at = tomorrow 9am, last_run_at = now()
 ↓ actions.get('agents.launch')({ agentId: A.id }, { payload: null, triggerId, table: _cronTriggers })
 ↓ handleLaunch(A.id)  — existing code at plugins/agents/server/internal/handle-launch.ts:21

[Agent A is deleted]
 ↓ agents plugin's DELETE handler still needs one line:
    await db.delete(_cronTriggers).where(sql`action_name='agents.launch' AND action_config->>'agentId'=${A.id}`)
```

Cron triggers don't have a domain FK to cascade from, so cron-triggered cleanup remains a per-plugin concern. Acceptable: the only plugins creating cron triggers know what they pointed at.

### Flow 2 — conversation completes → launch reviewer agent

```
User configures: "when conversations spawned by A finish, launch reviewer R".
 ↓ INSERT INTO conversation_completed_triggers (
     conversation_id = NULL,           -- match any conversation
     spawned_by      = A.id,           -- ...spawned by A
     action_name     = 'agents.launch',
     action_config   = { agentId: R.id, prompt: 'review' },
     one_shot        = false,          -- recurring
   )

[conversation C spawned by A finishes; poller observes runtime is dead]
 ↓ updateConversation(C.id, { status: 'gone', endedAt: new Date() })   // poller.ts:92
 ↓ await conversationCompleted.emit({ conversationId: C.id, spawnedBy: A.id })
 ↓ SQL:
    SELECT * FROM conversation_completed_triggers
     WHERE enabled
       AND (conversation_id IS NULL OR conversation_id = 'C.id')
       AND (spawned_by      IS NULL OR spawned_by      = 'A.id')
   → returns our row
 ↓ actions.get('agents.launch')({ agentId: R.id, prompt: 'review' }, ...)
 ↓ handleLaunch(R.id, { prompt: 'review' })

[Conversation C is deleted from the DB]
 ↓ FK ON DELETE CASCADE cleans up any conversation_completed_triggers with
   conversation_id = C.id automatically. (Triggers with conversation_id NULL
   survive — they target "any conversation".)

[Agent R is deleted]
 ↓ agents plugin's DELETE handler removes triggers whose action targeted R:
    await db.delete(_conversationCompletedTriggers)
            .where(sql`action_name='agents.launch' AND action_config->>'agentId'=${R.id}`)
```

Note the asymmetry: FK cascade handles cleanup when the *match target* (the conversation) is deleted; per-plugin handlers still handle cleanup when the *action target* (the agent) is deleted, because actions reference targets by ID-in-JSONB. That's fine — the deletion sites are few (one per plugin that owns action targets) and the queries are simple.

### Flow 3 — task done → launch queued child

```
User clicks "Create & queue" on parent X for child Y.
 ↓ tasks plugin:
    Y = createTask({ parentId: X.id, title: 'Y' })
    INSERT INTO task_completed_triggers (
      task_id       = X.id,
      action_name   = 'tasks.launch',
      action_config = { taskId: Y.id },
      one_shot      = true,             -- default; fires once then deletes
    )

[X transitions to done]
 ↓ insertPush(...) completes X's attempt → tasks_v derives X as done
 ↓ post-write check: status was 'open', now 'done' → emit:
    await taskCompleted.emit({ taskId: X.id, parentId: X.parentId, status: 'success' })
 ↓ SQL:
    SELECT * FROM task_completed_triggers
     WHERE enabled AND (task_id IS NULL OR task_id = 'X.id')
   → returns our row
 ↓ actions.get('tasks.launch')({ taskId: Y.id }, ...)
 ↓ createConversation for Y, status → 'starting'
 ↓ one_shot=true → DELETE FROM task_completed_triggers WHERE id = row.id

[X is deleted instead of completing]
 ↓ FK ON DELETE CASCADE removes the row automatically. No queued launch happens.
```

### Multi-key match in action

The conversation-completed example above filters on *both* `conversation_id` and `spawned_by`. This was awkward in v3 (would have needed `'X:Y'` string encoding) and is now just normal SQL. The same pattern extends to any new event with multiple useful filterable keys.

## Compound triggers — still deferred

Same sketch as v2/v3, slightly cleaner in the per-table model:

- A new `_compound_states` table in the events plugin: `(id, required, fired, action_name, action_config)`.
- Compound = N rows across various event-trigger tables, each with `actionName = 'compound.step'` and `actionConfig = { groupId: G }`.
- The built-in `compound.step` action atomically increments `fired`, fires the real action when `fired >= required`, and deletes sibling rows (one DELETE per event-trigger table, scoped by `action_config->>'groupId'`).
- FK cascade on each child row handles partial-cleanup when one of the targets is deleted before the compound completes — but the orphaned `_compound_states` row needs explicit cleanup. Address that with the first real use case.

Don't ship in v1. The three concrete flows are all single-event.

## File layout

```
plugins/events/
├── server/
│   ├── index.ts                      # ServerPluginDefinition; onReady starts cron scheduler
│   ├── api.ts                        # defineEventType, registerAction, emit, createCronTrigger,
│   │                                 # eventTriggerColumns helper, ActionContext type
│   └── internal/
│       ├── tables.ts                 # _cron_triggers
│       ├── dispatch.ts               # runAction: registry lookup, one-shot delete, error log
│       └── cron-scheduler.ts         # setInterval poller (push-watcher pattern)

plugins/tasks-core/
├── server/
│   ├── api.ts                        # exports taskCompleted, conversationCompleted EventTypeDefs
│   │                                 # + tasks.launch action
│   └── internal/
│       ├── tables.ts                 # ...existing tables + _task_completed_triggers,
│       │                             # _conversation_completed_triggers
│       └── mutations/
│           ├── tasks.ts              # taskCompleted.emit(...) on derived not-done→done
│           └── pushes.ts             # taskCompleted.emit(...) after insertPush completes attempt

plugins/conversations/
└── server/
    └── internal/
        └── poller.ts                 # conversationCompleted.emit(...) after updateConversation→gone

plugins/agents/
└── server/
    └── api.ts                        # registers agents.launch action wrapping handleLaunch
```

## Critical files / references

- `plugins/events/server/internal/tables.ts` — **new**: `_cron_triggers`.
- `plugins/events/server/api.ts` — **new**: `defineEventType`, `registerAction`, `emit`, `createCronTrigger`, `eventTriggerColumns`.
- `plugins/events/server/internal/cron-scheduler.ts` — **new**: modelled on [`plugins/tasks/server/internal/push-watcher.ts:131`](../plugins/tasks/server/internal/push-watcher.ts).
- `plugins/events/server/internal/dispatch.ts` — **new**: `runAction(row, payload)` — registry lookup, one-shot delete, error log.
- `plugins/events/server/index.ts` — **new**: `ServerPluginDefinition` with `onReady: () => startCronScheduler()`.
- `plugins/tasks-core/server/internal/tables.ts` — **modify**: add `_task_completed_triggers`, `_conversation_completed_triggers`, both spreading `eventTriggerColumns()` + their typed FK columns + partial indexes on the FK columns.
- `plugins/tasks-core/server/api.ts` — **modify**: declare and export `taskCompleted`, `conversationCompleted` `EventTypeDef`s; register `tasks.launch` action.
- `plugins/tasks-core/server/internal/mutations/tasks.ts` — **modify** [`updateTask` at line 53](../plugins/tasks-core/server/internal/mutations/tasks.ts): emit `taskCompleted` on not-done→done transition.
- `plugins/tasks-core/server/internal/mutations/pushes.ts` — **modify**: emit `taskCompleted` after the attempt completes via push (re-deriving task status).
- `plugins/conversations/server/internal/poller.ts` — **modify** [line 92 + 122](../plugins/conversations/server/internal/poller.ts): emit `conversationCompleted` after `updateConversation(..., { status: 'gone' })`.
- `plugins/agents/server/api.ts` — **modify**: register `agents.launch` action wrapping [`handleLaunch` at line 21](../plugins/agents/server/internal/handle-launch.ts).
- `server/src/db/schema.ts` — **modify**: add `export * from "@plugins/infra/plugins/events/server/internal/tables"` (line ordering: leaves first, so put it before `tasks-core` if events/cron has no deps — but since `_task_completed_triggers` imports `eventTriggerColumns` from events, events/api can be imported as-needed without changing tables-export order).
- `server/src/plugins.ts` — **modify**: register `eventsPlugin` in the plugins list.

## Deferred (same as v3)

- Compound `all`/`any` triggers — sketch above; ship when first real use case lands.
- Retries on action failure — log and continue for v1.
- Frontend-side events — `resources` covers UI reactivity; revisit if a real need appears.
- Cross-process dispatch — out of scope; single server per worktree.
- Explicit `_tasks.completedAt` column — flagged as the cleaner long-term alternative to multi-site re-derivation in `taskCompleted`'s emit discipline; out of scope here.

## Verification

End-to-end checks after implementation:

1. **Cron flow.** `await createCronTrigger({ cronExpr: '*/1 * * * *', action: 'noop', config: {} })`. Watch `next_run_at` advance each minute, `last_run_at` update, action handler fire within 5s.
2. **Event flow (one-shot).** Insert task X, INSERT into `task_completed_triggers` with `task_id=X.id, one_shot=true`. Mark X done. Verify action fires, row is deleted.
3. **Event flow (recurring).** Same with `one_shot=false`. Mark X done twice (re-open + re-complete). Verify action fires twice, row persists.
4. **Multi-key match.** Insert two `conversation_completed_triggers`: one with `(conversation_id=NULL, spawned_by='A')`, one with `(conversation_id='C', spawned_by=NULL)`. Emit `{ conversationId: 'C', spawnedBy: 'A' }` — both fire. Emit `{ conversationId: 'C', spawnedBy: 'B' }` — only the second fires. Emit `{ conversationId: 'D', spawnedBy: 'A' }` — only the first fires.
5. **FK cascade cleanup.** Insert a `task_completed_triggers` row with `task_id=X.id`. Delete X. Confirm the row is gone (`SELECT … WHERE task_id = 'X.id'` empty).
6. **Action-target cleanup (per-plugin handler).** Cron trigger for agent A. Delete A. Confirm the agents plugin's delete handler removes the cron row.
7. **Missed cron on restart.** 20-minute downtime on `*/5 * * * *`. Action fires *once* on resume, not 4×.
8. **Index use.** `EXPLAIN` the emit query at 5k rows in `task_completed_triggers` across 100 distinct task_ids — Index Scan on the partial index, not seq scan.

Unit tests:

- `defineEventType<T>` type inference: `match` callback's payload is typed as `T`; `emit(payload)` parameter is typed as `T`; columns referenced inside `match` are typed against the bound `table`.
- `event.emit(payload)` against an event type with no matching rows: no-op, no errors, no spurious deletes.
- `runAction` with unknown `action_name`: log warning, do not delete the row (so a later `registerAction` of the missing handler can pick it up next time).
- Cron `tickOnce` with a mocked clock: SKIP LOCKED contention, missed-run behavior, `next_run_at` advancement.
