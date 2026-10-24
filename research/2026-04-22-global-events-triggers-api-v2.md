# Events & Triggers API — v2 (technical design)

> Supersedes [v1](./2026-04-22-global-events-triggers-api.md) for internals. The public API shape (`defineEvent`, `defineAction`, `createTrigger`) is unchanged; v2 locks down **storage** and **dispatch** — what exactly wakes an event up, where the row lives, what the query on `emit` looks like.

## Context

v1 fixed the API shape but left storage and dispatch as "deferred to follow-up". The concrete use cases pressing on this:

1. **Cron → launch agent.** Agent row has `{ trigger: { cron: '0 9 * * *' } }`; every 9am launches it.
2. **Agent finished → launch reviewer.** When conversation `C` completes, spawn a separate "review" agent.
3. **Task marked done → next task.** The "Create & queue" button from v1: parent task completes, queued child auto-launches.

Each has a different natural dispatch mechanism. A single polymorphic `triggers` table with a JSONB `when` column would force all three through the same query path and lose the indexing properties each one needs. v2 picks **one table per trigger source**, each with its own dispatcher, unified under the same action registry.

## Plugin layout

```
plugins/events/
├── server/
│   ├── index.ts                    # plugin definition, exports defineEvent/defineAction/createTrigger
│   ├── api.ts                      # cross-plugin types (Event<T>, Action<T>, Trigger)
│   └── internal/
│       ├── tables.ts               # event_subscriptions, cron_subscriptions
│       ├── registry.ts             # in-memory action registry + ephemeral listeners
│       ├── dispatch.ts             # emit() → fanout to ephemeral + persistent
│       └── cron-scheduler.ts       # setInterval poller for cron_subscriptions
└── web/
    └── index.ts                    # (later) Triggers.Source slot for custom UI
```

`events` is a new root plugin. `tasks` / `agents` / `conversations` depend on it via plain module imports (matching the v1-described pattern — no registry).

## Storage

Two tables, one per source type. Each owns its own index strategy. A third (`compound_state`) is stubbed for later but not shipped in v1.

### `event_subscriptions` — persistent pattern-match subscriptions

```ts
// plugins/events/server/internal/tables.ts
export const _eventSubscriptions = pgTable('_event_subscriptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  eventName: text('event_name').notNull(),           // e.g. 'tasks.completed'
  matchKeys: jsonb('match_keys')                     // e.g. {"taskId":"abc"}; {} = match-all
    .$type<Record<string, string>>().notNull().default({}),
  actionName: text('action_name').notNull(),        // e.g. 'agents.launch'
  actionConfig: jsonb('action_config')              // payload passed to action.run()
    .$type<Record<string, unknown>>().notNull(),
  enabled: boolean('enabled').notNull().default(true),
  firesRemaining: integer('fires_remaining'),       // null = unbounded, 1 = one-shot
  ownerKind: text('owner_kind'),                    // 'agent' | 'task' | null — for UI + cleanup
  ownerId: text('owner_id'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (t) => [
  // Primary probe: event_name + any declared key the caller filtered on.
  index('event_subs_event_idx').on(t.eventName).where(sql`enabled`),
  // Per-key expression indexes — one per key declared across all defineEvent({keys: [...]}):
  index('event_subs_taskId_idx').on(t.eventName, sql`(match_keys->>'taskId')`).where(sql`enabled`),
  index('event_subs_conversationId_idx').on(t.eventName, sql`(match_keys->>'conversationId')`).where(sql`enabled`),
  index('event_subs_agentId_idx').on(t.eventName, sql`(match_keys->>'agentId')`).where(sql`enabled`),
  // For cascade-delete when an owning agent/task is removed:
  index('event_subs_owner_idx').on(t.ownerKind, t.ownerId),
]);
```

**Match semantics.** Subscription matches an event iff `matchKeys ⊆ payload[declared_keys]`. Empty `matchKeys` matches every emit of that event. A subscription with `{taskId: 'X'}` matches events carrying `taskId === 'X'`. No wildcards, no operators — if you need richer predicates, add a dedicated trigger source plugin.

**Key-index policy.** The set of indexed keys is the *union* of all `defineEvent({keys})` across all plugins. Each new key in a new event definition means a new expression index. This is a build-time concern: we statically know the set. The `./equin build` migration pass regenerates `tables.ts` indexes from the declared events (how: a codegen step scans `plugins/*/server/api.ts` for `defineEvent` calls and emits the index list — or simpler, we maintain the list by hand in `tables.ts` and fail CI if a new `defineEvent` references an unindexed key).

### `cron_subscriptions` — time-based triggers

```ts
export const _cronSubscriptions = pgTable('_cron_subscriptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  cronExpr: text('cron_expr').notNull(),             // validated against cron-parser at insert
  nextRunAt: timestamp('next_run_at').notNull(),    // precomputed on insert and after each fire
  lastRunAt: timestamp('last_run_at'),
  actionName: text('action_name').notNull(),
  actionConfig: jsonb('action_config')
    .$type<Record<string, unknown>>().notNull(),
  enabled: boolean('enabled').notNull().default(true),
  ownerKind: text('owner_kind'),
  ownerId: text('owner_id'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (t) => [
  // The scheduler's one query — (next_run_at asc) filtered on enabled.
  index('cron_subs_due_idx').on(t.nextRunAt).where(sql`enabled`),
]);
```

**No `interval_ms` column.** Cron is the only supported spec — one format covers "every 5 min" (`*/5 * * * *`) through "every Monday 9am". `cron-parser` (npm, ~15KB, no deps) computes `next_run_at`.

### `compound_state` — deferred

Compound (`all` / `any`) triggers decompose into N rows in `event_subscriptions` plus one `compound_state` row tracking `{group_id, required, fired}`. Each child subscription's action is the internal `events.compoundStep` action, which increments the counter and — if threshold hit — runs the outer action and cleans up siblings. **Not shipped in v1**: start with single-event, add this if/when a real use case demands it.

## Dispatch — "what wakes the event up"

There are exactly two wake-up paths. Neither uses LISTEN/NOTIFY (consistent with the rest of the codebase).

### Path A: `emit()` — in-process synchronous fanout

The same process that mutates state calls `emit`. This is the only wake-up mechanism for event-based triggers. No changefeed, no cross-process discovery.

```ts
// plugins/events/server/internal/dispatch.ts
export async function dispatch<T>(event: EventDef<T>, payload: T) {
  // 1. Ephemeral in-process listeners (event.on / event.once callers).
  //    Run first, synchronously awaited, wrapped in try/catch per-handler.
  for (const handler of ephemeralListeners.get(event.name) ?? []) {
    try { await handler(payload); }
    catch (e) { log.error({ event: event.name, err: e }, 'ephemeral handler threw'); }
  }

  // 2. Persistent subscriptions — one indexed SQL query.
  const keyValues = pickDeclaredKeys(event.keys, payload); // e.g. {taskId: 'X', parentId: 'Y'}
  const subs = await db.select().from(_eventSubscriptions).where(and(
    eq(_eventSubscriptions.eventName, event.name),
    eq(_eventSubscriptions.enabled, true),
    // matchKeys must be a subset of the event's declared-key values.
    sql`${_eventSubscriptions.matchKeys} <@ ${JSON.stringify(keyValues)}::jsonb`,
  ));

  // 3. Invoke actions in parallel; decrement firesRemaining atomically.
  await Promise.all(subs.map(sub => runSubscription(sub, payload)));
}
```

**The operator `<@` is "left contained in right"**. Subscription's `matchKeys` must be a subset of the event's key/value pairs. `{}` is a subset of anything — matches all. This lets us bypass fetching and filtering in JS.

**Index use.** The query plan, for `emit(taskCompleted, {taskId: 'X', parentId: 'Y', status: 'success'})`:

- If any subscription filters on `taskId`, the `event_subs_taskId_idx` probe gives `(event_name='tasks.completed', match_keys->>'taskId' IN ('X', NULL))` in log(N) on index size.
- For subscriptions with empty `matchKeys`, they're picked up by `event_subs_event_idx`.
- In practice, a single seq scan on the `event_name` partial index is fast below ~10k subscriptions — the specialized per-key indexes matter once one owner (e.g. tasks) accumulates many subscriptions.

**`firesRemaining` handling**:

```ts
async function runSubscription(sub: Row, payload: unknown) {
  const action = registry.actions.get(sub.actionName);
  if (!action) { log.warn({ actionName: sub.actionName }, 'unknown action'); return; }

  try {
    await action.run(sub.actionConfig, { payload, subscription: sub });
  } catch (e) {
    log.error({ sub: sub.id, err: e }, 'action threw');
    // v1: log and continue. No retries. Retry story is a separate design.
  }

  if (sub.firesRemaining === 1) {
    await db.delete(_eventSubscriptions).where(eq(_eventSubscriptions.id, sub.id));
  } else if (sub.firesRemaining != null) {
    await db.update(_eventSubscriptions)
      .set({ firesRemaining: sub.firesRemaining - 1 })
      .where(eq(_eventSubscriptions.id, sub.id));
  }
}
```

### Path B: Cron scheduler — `setInterval` poller

One scheduler, one process, one `setInterval`. Started from `plugins/events/server/index.ts`'s `onReady` hook.

```ts
// plugins/events/server/internal/cron-scheduler.ts
const TICK_MS = 5_000; // matches the "fast enough" end of existing pollers (1s) vs. DB load tradeoff.

export function startCronScheduler() {
  setInterval(async () => {
    try { await tickOnce(); }
    catch (e) { log.error({ err: e }, 'cron tick failed'); }
  }, TICK_MS);
}

async function tickOnce() {
  // Atomically claim + advance due rows. FOR UPDATE SKIP LOCKED is future-proofing for
  // a multi-process deployment; today we have a single server per worktree so it's cheap insurance.
  const due = await db.transaction(async (tx) => {
    const rows = await tx.execute<CronRow>(sql`
      SELECT * FROM _cron_subscriptions
       WHERE enabled AND next_run_at <= now()
       ORDER BY next_run_at
       LIMIT 100
       FOR UPDATE SKIP LOCKED
    `);
    for (const r of rows) {
      const next = parseCron(r.cron_expr).next().toDate();
      await tx.execute(sql`
        UPDATE _cron_subscriptions
           SET next_run_at = ${next}, last_run_at = now()
         WHERE id = ${r.id}
      `);
    }
    return rows;
  });

  await Promise.all(due.map(r => runCronAction(r)));
}
```

**Why poll vs. LISTEN/NOTIFY:** cron is a wall-clock event; nobody emits it. Polling is the only mechanism. The codebase already has two 1s `setInterval` pollers ([conversations poller](../plugins/conversations/server/internal/poller.ts), [push-watcher](../plugins/tasks/server/internal/push-watcher.ts)), so this is idiomatic. 5s tick caps user-visible lag at 5s — fine for cron.

**Missed runs on restart:** if the server was down for an hour, `next_run_at` for all due rows is in the past — they all fire on the next tick. The `LIMIT 100` per tick throttles the catch-up. `cron-parser` will return `now()`'s next occurrence, not a retroactive stack; so "every 5 min" missed for an hour fires *once* on resume, not 12 times. That's the right default for equin (you don't want 12 agent launches queued because the laptop slept). If we need strict "fire once per missed slot", add a `catchup_mode` column later.

### What about "task row changed" → "task.completed" emit?

The tasks plugin is the source of truth for task state. When its own code mutates the row (e.g. `updateTask(...)` in `plugins/tasks-core/server`), it calls `await taskCompleted.emit({...})` *in the same function, in the same process*. There is no scenario where a task row changes but no emit happens — because we own the write path.

If someone changes the row via raw SQL outside the plugin code, no emit fires. That's a bug in the caller, not a gap in the dispatch mechanism. The discipline: **all state mutations go through plugin APIs that emit**, same way they already notify resources.

## Actions — the registry

`defineAction` registers into an in-process `Map<string, Action>`. Populated at plugin-load time (each plugin's module-level code).

```ts
// plugins/events/server/api.ts
export function defineAction<C extends z.ZodType>(def: {
  name: string;
  configSchema: C;
  run: (config: z.infer<C>, ctx: ActionContext) => Promise<void> | void;
}): Action<C> { registry.actions.set(def.name, def); return def; }

export interface ActionContext {
  payload: unknown;                    // the event payload that triggered us (null for cron)
  subscription: SubscriptionRow;       // the row that fired — lets actions introspect owner_id etc.
}
```

**No DB handle in `ctx`.** Actions import what they need from `@plugins/tasks-core/server` (Drizzle handle, repo fns) — matching the existing pattern. Keeping `ctx` minimal avoids reimplementing dependency injection.

**Initial actions** (one per use case):

| Action name | Config | Calls |
|---|---|---|
| `agents.launch` | `{ agentId: string, prompt?: string }` | `handleLaunch` at `plugins/agents/server/internal/handle-launch.ts:21` |
| `tasks.launch` | `{ taskId: string, prompt?: string, model?: ConversationModel }` | `createConversation` at `plugins/conversations/server/internal/lifecycle.ts:34` with the given task |

Each plugin defines its own actions in its own `server/api.ts`, importing `defineAction` from `@plugins/infra/plugins/events/server`.

## End-to-end flows

### Flow 1 — Cron launches an agent

```
User edits agent A, sets schedule: '0 9 * * *'.
 ↓
Agents UI: POST /api/agents/:id → agents plugin handler
 ↓
agents plugin calls createTrigger({
  when: { cron: '0 9 * * *' },
  then: { action: 'agents.launch', config: { agentId: A.id } },
  owner: { kind: 'agent', id: A.id },
})
 ↓
events plugin:
  nextRunAt = cronParser.parseExpression('0 9 * * *').next().toDate()
  INSERT INTO _cron_subscriptions (...) VALUES (...)
 ↓
[no more work until 9am]
 ↓
9:00:00 — cron scheduler's 5s tick hits at 9:00:03:
  SELECT * FROM _cron_subscriptions WHERE enabled AND next_run_at <= now() FOR UPDATE SKIP LOCKED
    → returns row for agent A with next_run_at = today 9:00:00
  UPDATE _cron_subscriptions SET next_run_at = 'tomorrow 9:00:00', last_run_at = now()
 ↓
runCronAction(row):
  registry.actions.get('agents.launch').run({ agentId: A.id }, { payload: null, subscription: row })
 ↓
agents.launch impl calls existing handleLaunch(A.id)
  → createTask(parentId: AGENTS_META_TASK_ID, ...)
  → createConversation(taskId, ...)
  → INSERT _agent_launches, agentLaunchesResource.notify()
 ↓
Agent running. Scheduler row now has next_run_at = tomorrow 9:00.
```

**If the user deletes agent A:** agents plugin's delete handler issues `DELETE FROM _cron_subscriptions WHERE owner_kind='agent' AND owner_id=A.id` (indexed by `cron_subs_owner_idx` if we add it — v1 can scan). No orphan triggers.

### Flow 2 — Conversation completes → launch review agent

```
User configures agent A with trigger: "when my conversations finish, launch review agent R".
 ↓
createTrigger({
  when: { event: conversationCompleted, where: { /* empty: match any conversation spawned by A */ } },
  then: { action: 'agents.launch', config: { agentId: R.id, prompt: 'review the changes' } },
  owner: { kind: 'agent', id: A.id },
})
 ↓
events plugin: INSERT INTO _event_subscriptions (event_name='conversations.completed', match_keys='{}', ...)
 ↓
[wait for a conversation spawned by A to finish]
 ↓
conversations plugin's poller detects status change → calls conversations/server/internal/lifecycle.markCompleted(C)
 ↓
inside markCompleted, after DB update:
  await conversationCompleted.emit({ conversationId: C.id, spawnedBy: 'A', status: 'success', taskId: T })
 ↓
dispatch(conversationCompleted, payload):
  1. Fire ephemeral .on() listeners (e.g. UI push, resources.notify cascade)
  2. SQL:
     SELECT * FROM _event_subscriptions
      WHERE event_name = 'conversations.completed' AND enabled
        AND match_keys <@ '{"conversationId":"C.id","spawnedBy":"A",...}'::jsonb
     → returns the subscription row (match_keys = {} is subset of anything)
  3. For each: runSubscription
     → registry.actions.get('agents.launch').run({ agentId: R.id, prompt: 'review...' }, { payload, subscription })
     → handleLaunch(R.id, { prompt })
```

Match-key filtering example: if the user instead wanted "only when agent A's own conversations finish", the subscription would have `match_keys: { spawnedBy: 'A' }`. The emit payload carries `spawnedBy`, so the `<@` test succeeds for A's conversations and fails for everyone else's. No work done in JS.

### Flow 3 — Task marked done → launch next task

```
User clicks "Create & queue" on task X's child popover, entering child Y.
 ↓
POST /api/tasks → tasks plugin:
  1. createTask(parentId: X, title: 'Y', status: 'pending')  → returns Y
  2. createTrigger({
       when: { event: taskCompleted, where: { taskId: X.id } },
       then: { action: 'tasks.launch', config: { taskId: Y.id } },
       owner: { kind: 'task', id: Y.id },
       firesRemaining: 1,                 // one-shot: fires once then deletes itself
     })
 ↓
INSERT INTO _event_subscriptions (event_name='tasks.completed', match_keys='{"taskId":"X.id"}', fires_remaining=1, ...)
 ↓
[later] User marks X done. tasks plugin updateTask(X, {status:'done'}) → emits:
  await taskCompleted.emit({ taskId: X.id, parentId: X.parentId, status: 'success' })
 ↓
dispatch:
  SELECT * FROM _event_subscriptions
   WHERE event_name = 'tasks.completed' AND enabled
     AND match_keys <@ '{"taskId":"X.id","parentId":"..."}'::jsonb
  → returns our subscription (matches on taskId)
 ↓
runSubscription:
  tasks.launch.run({ taskId: Y.id }) → createConversation for task Y, status → 'running'
  fires_remaining was 1 → DELETE FROM _event_subscriptions WHERE id = subscription.id
 ↓
User cancels the queue before X completes:
  DELETE FROM _event_subscriptions WHERE owner_kind='task' AND owner_id=Y.id
```

## Lifecycle + ownership rules

- Every trigger has an `ownerKind` + `ownerId`. When the owner is deleted, cascade-delete its triggers in the same transaction. This is the only cleanup path — no orphan scanner.
- `firesRemaining`: `null` = unbounded (default for cron — cron reschedules itself), integer = countdown, `1` = one-shot (default for event triggers created from UI).
- Disable vs. delete: UI sets `enabled=false` to pause; `DELETE` to remove. Partial indexes `WHERE enabled` ignore paused rows entirely.

## API recap (unchanged from v1)

```ts
// Event — produced and consumed by plugins
export const taskCompleted = defineEvent({
  name: 'tasks.completed',
  payload: z.object({ taskId: z.string(), parentId: z.string().nullable(), status: z.enum(['success','failure']) }),
  keys: ['taskId', 'parentId'],
});

await taskCompleted.emit({ taskId, parentId, status: 'success' });  // producer
taskCompleted.on(payload => {...});                                  // ephemeral subscriber
await taskCompleted.once({ where: { taskId: 'X' } });               // one-shot await

// Action — verb invoked by triggers
export const launchTask = defineAction({
  name: 'tasks.launch',
  configSchema: z.object({ taskId: z.string(), prompt: z.string().optional() }),
  run: async (cfg, ctx) => { await createConversation({ taskId: cfg.taskId, prompt: cfg.prompt ?? '' }); },
});

// Trigger — persistent row
await createTrigger({
  when: { event: taskCompleted, where: { taskId: 'X' } },
  then: { action: launchTask, config: { taskId: 'Y' } },
  owner: { kind: 'task', id: 'Y' },
  firesRemaining: 1,
});
await createTrigger({
  when: { cron: '0 9 * * *' },
  then: { action: launchAgent, config: { agentId: 'A' } },
  owner: { kind: 'agent', id: 'A' },
});
```

## Critical files / references

- `plugins/events/server/internal/tables.ts` — **new**: two tables above.
- `plugins/events/server/internal/dispatch.ts` — **new**: `dispatch()` fn, the `<@` query.
- `plugins/events/server/internal/cron-scheduler.ts` — **new**: setInterval poller, modelled on [`plugins/tasks/server/internal/push-watcher.ts:131`](../plugins/tasks/server/internal/push-watcher.ts).
- `plugins/events/server/internal/registry.ts` — **new**: action registry + ephemeral listener map.
- `plugins/events/server/api.ts` — **new**: `defineEvent`, `defineAction`, `createTrigger` exports.
- `plugins/events/server/index.ts` — **new**: `ServerPluginDefinition` with `onReady: startCronScheduler`.
- `plugins/tasks/server/api.ts` — define `taskCompleted` event + `launchTask` action.
- `plugins/conversations/server/api.ts` — define `conversationCompleted` event; call `.emit()` inside `lifecycle.markCompleted`.
- `plugins/agents/server/api.ts` — define `launchAgent` action wrapping `handleLaunch` ([`plugins/agents/server/internal/handle-launch.ts:21`](../plugins/agents/server/internal/handle-launch.ts)).
- `server/src/db/schema.ts` — add `export * from '@plugins/infra/plugins/events/server/schema'`.

## Deferred (not in v1 shipping)

1. **Compound `all`/`any` triggers** — design sketched (decompose into N subscriptions + `compound_state` row); ship when a real use case lands.
2. **Retries / backoff on action failure** — v1 logs and continues. If needed, add `retries_remaining`/`retry_at` columns on subscriptions.
3. **Frontend-side events** — in-browser `event.on` over the WS. Not needed for these use cases; resources cover most UI reactivity.
4. **Cross-process dispatch** — current design is single-process. Multi-server would need LISTEN/NOTIFY or a message broker; not on the roadmap.
5. **Catch-up semantics for cron** — default is "fire once on resume". Add `catchup_mode: 'single' | 'all'` column if anyone actually wants replay.
6. **Codegen for per-key indexes** — v1 maintains the index list in `tables.ts` by hand + a `./equin check` check that fails if an undeclared key appears in any `defineEvent`. Auto-gen later if the list grows.

## Verification

End-to-end checks after implementation:

1. **Cron flow.** Create a cron trigger with `*/1 * * * *` pointing at a no-op action. Observe `_cron_subscriptions.next_run_at` advances each minute, action fires within 5s of `now()`, `last_run_at` updates.
2. **Event flow (one-shot).** Insert a task `X`, click "Create & queue" for child `Y`. Confirm `_event_subscriptions` row with `fires_remaining=1`. Mark `X` done — conversation for `Y` starts, subscription row is deleted.
3. **Event flow (ownership cascade).** Create a conversation-completed trigger owned by agent A. Delete agent A. Confirm subscription row is gone.
4. **Missed cron on restart.** Create `*/5 * * * *` trigger, stop server for 20 min, restart. Action fires *once* on resume, not four times.
5. **Match semantics.** Two subscriptions on same event: one with `match_keys={taskId: 'X'}`, one with `{}`. Emit with `taskId: 'X'` — both fire. Emit with `taskId: 'Y'` — only the `{}` one fires.
6. **Index use.** `EXPLAIN` the dispatch query with 5k subscriptions across 10 event types; confirm Index Scan on `event_subs_taskId_idx` or the partial `event_subs_event_idx`, not a seq scan.
7. **Perf.** 10k subscriptions, emit one event that matches 1 — under 10ms for the SQL probe. (`O(matches)`, not `O(N)` goal from v1.)

Unit tests:
- `defineEvent` type inference (tsd): filtering on a non-declared key is a compile error.
- `dispatch()` in-memory: ephemeral handler throwing doesn't block persistent fanout.
- `cron-scheduler.tickOnce()` with a mocked clock: SKIP LOCKED contention, missed-run behavior.
