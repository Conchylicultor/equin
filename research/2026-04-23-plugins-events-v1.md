---
name: Events plugin — v1 implementation spec
status: ready-to-implement
scope: Events, Actions, Triggers (single-event only). No cron, no compound.
---

# Events plugin — v1 implementation spec

This doc is self-contained: reading it is enough to implement the first version of the `events` plugin without further context.

## Scope

**In scope for v1:**

- A new `events` plugin owning the infrastructure (registry, dispatcher, cleanup helpers).
- `defineTriggerEvent` — factory used by *other plugins* to declare typed events.
- `defineAction` — factory used to declare typed, registered action handlers.
- `trigger(...)` — free function that persists a subscription binding a source to an action.
- Single-event sources only: "when event E fires matching filter F, run action A with config C".
- FK-cascade cleanup when the match target is deleted.
- `deleteTrigger` and per-action `.deleteTargeting` helpers for the other two cleanup paths.

**Out of scope (do not implement, do not design around):**

- Cron sources (wall-clock scheduled triggers).
- Compound sources (`And` / `Or` / N-of-M across events).
- Retries on action failure (log and continue).
- Frontend-side events (resources already cover UI reactivity).

These features were designed alongside v1 but are intentionally deferred. The v1 API shape has been validated against them — the `on:` slot accepts any `Source`, so adding a `CompoundSource` or `CronSource` later is purely additive.

## The three concepts

**Event.** A named fact that a plugin emits when its state changes. Defined once per event type via `defineTriggerEvent` (e.g. `taskCompleted`), emitted many times from the mutation sites that cause the transition. Each event carries a typed payload.

An event export is dual-purpose: it has `.emit(payload)` for the owning plugin, and it is itself a `Source` usable in `trigger({ on: ... })` — either bare (match-any) or refined via `.where({...})`.

**Action.** A typed handler registered once at plugin load via `defineAction`. The factory returned from `defineAction` is callable: calling it with a config produces an `ActionRef` — a typed, serializable `{ name, config }` pair — which is what `trigger({ do: ... })` accepts. The string name is the stable DB identifier; callers never type it.

Action config is defined with a **zod schema**, which doubles as the TS type (`z.infer`) and a runtime validator at dispatch time. Persisted `action_config` JSONB outlives the TS type that wrote it, so schema drift across deploys is caught at the dispatcher boundary rather than halfway through a handler.

**Trigger.** A persisted row linking a source's filter columns to an action's `{name, config}`. Created via `trigger(...)`. One row per subscription, stored in the event's own per-type table.

The framework's only job: when an event is emitted, find rows whose filter matches the payload, invoke each row's action.

## Grounding example

**User story.** Etienne wants: *when task X completes, auto-launch agent A to review the result.*

- **Event** — `taskCompleted`, defined by the `tasks-core` plugin. Payload: `{ taskId, parentId, status }`.
- **Action** — `launchAgent`, defined by the `agents` plugin. Config: `{ agentId, prompt? }`. Name: `"agents.launch"`.
- **Trigger** — a row inserted into `_task_completed_triggers` with `task_id=X.id`, `action_name="agents.launch"`, `action_config={agentId:A.id}`, `one_shot=true`.

**Flow at wire level:**

1. Some code (e.g. the agents plugin's HTTP handler) creates the trigger:
   ```ts
   await trigger({
     on: taskCompleted.where({ taskId: X.id }),
     do: launchAgent({ agentId: A.id }),
     oneShot: true,
   });
   ```
2. Later, `insertPush(...)` in `tasks-core` marks X's attempt complete. The same function emits:
   ```ts
   await taskCompleted.emit({ taskId: X.id, parentId: X.parentId, status: "success" });
   ```
3. The dispatcher runs `SELECT * FROM _task_completed_triggers WHERE enabled AND (task_id IS NULL OR task_id = 'X.id')`, finds the row, looks up `"agents.launch"` in the action registry, calls it with `{agentId: A.id}`. Agent A launches.
4. `one_shot=true` → the dispatcher deletes the row.

**Cleanup cases (all free, or nearly so):**

- Task X is deleted before completing → FK `ON DELETE CASCADE` removes the trigger row automatically.
- Agent A is deleted → agents plugin's delete handler calls `launchAgent.deleteTargeting({ agentId: A.id })` to sweep all trigger tables.
- User changes their mind and removes the trigger from the UI → `deleteTrigger(triggerId)`.

This single flow exercises every part of the v1 API.

## Public API

All exports live in `plugins/events/server/index.ts`.

```ts
// ─── Source (what goes in `on:`) ─────────────────────────────────────
//
// v1 has one Source kind: EventSource. The type stays a union-ready shape
// so compound/cron sources slot in later without changing `trigger`.

export interface Source<Payload = unknown> {
  readonly __kind: "event";              // future: "all" | "any" | "cron"
  // Remaining fields are opaque to callers; `trigger` inspects them.
}

// ─── Event definition ────────────────────────────────────────────────

// The event export is both a Source (match-any) and has `.emit` / `.where` / `.name`.
export type EventHandle<T, F> = Source<T> & {
  readonly name: string;
  emit(payload: T): Promise<void>;
  where(filter: Partial<InferFilter<F, T>>): Source<T>;
};

// Each filter slot is either a plain column (default identity-or-null match
// on the same-named payload key) or an object with a custom match predicate.
type FilterSlot<T, K extends keyof T> =
  | PgColumnBuilder
  | {
      column: PgColumnBuilder;
      match: (col: AnyPgColumn, payload: T) => SQL;
    };

export function defineTriggerEvent<
  T extends Record<string, unknown>,
  F extends { [K in keyof F]: FilterSlot<T, K & keyof T> },
>(def: {
  name: string;                                // e.g. "tasks.completed"
  filters: F;                                  // filter columns, keyed by payload key
  matchFn?: (t: Table, payload: T) => SQL;     // escape hatch (overrides per-filter match)
}): {
  table: PgTable;                              // export this at top level for drizzle-kit
  event: EventHandle<T, F>;
};

// ─── Action definition ───────────────────────────────────────────────
//
// `defineAction` registers the handler at module load and returns a callable
// factory. Calling it produces an ActionRef, which is what `trigger({ do })`
// accepts. The factory also carries static helpers (`.name`, `.schema`,
// `.deleteTargeting`).

export interface ActionRef<Name extends string = string, C = unknown> {
  readonly __kind: "action";
  readonly name: Name;
  readonly config: C;
}

export type ActionHandler<C> = (config: C, ctx: ActionContext) => Promise<void> | void;

export interface ActionContext {
  payload: unknown;
  triggerId: string;
  table: PgTable;
}

export type ActionFactory<Name extends string, Schema extends z.ZodType> =
  ((config: z.input<Schema>) => ActionRef<Name, z.infer<Schema>>) & {
    readonly name: Name;
    readonly schema: Schema;                                       // reusable for UI forms / HTTP input
    deleteTargeting(configMatch: Partial<z.infer<Schema>>): Promise<void>;
  };

export function defineAction<Name extends string, Schema extends z.ZodType>(spec: {
  name: Name;
  config: Schema;                                                  // zod schema, doubles as validator
  run: ActionHandler<z.infer<Schema>>;
}): ActionFactory<Name, Schema>;

// ─── Subscription ────────────────────────────────────────────────────

export function trigger<P>(spec: {
  on: Source<P>;
  do: ActionRef;
  oneShot?: boolean;                           // default true — delete row after firing
}): Promise<string>;                           // returns row id

// ─── Cleanup ─────────────────────────────────────────────────────────

export function deleteTrigger(id: string): Promise<void>;
```

### Event usage

```ts
// In plugins/tasks-core/server/internal/tables.ts
export const { event: taskCompleted, table: _taskCompletedTriggers } =
  defineTriggerEvent<{
    taskId: string;
    parentId: string | null;
    status: "success" | "failure";
  }>({
    name: "tasks.completed",
    filters: {
      taskId: text("task_id").references(() => _tasks.id, { onDelete: "cascade" }),
    },
  });
```

`taskCompleted` is the exported handle. It has `.emit(payload)` for tasks-core's mutation sites, and it is itself a match-any `Source`. `.where({ taskId })` returns a refined `Source` that narrows the match.

### Action usage

```ts
// In plugins/agents/server/index.ts
export const launchAgent = defineAction({
  name: "agents.launch",
  config: z.object({
    agentId: z.string(),
    prompt: z.string().optional(),
  }),
  run: async ({ agentId, prompt }) => handleLaunch(agentId, { prompt }),
});
```

The call to `defineAction` registers the handler as a side-effect. `launchAgent` is now a typed factory — callers import it and do `launchAgent({ agentId })`, which returns an `ActionRef<"agents.launch", {agentId, prompt?}>`. No stringly-typed `action` name at subscribe sites.

The schema is kept on the factory (`launchAgent.schema`) so it can be reused by UI forms, HTTP request validators, or anyone else who needs to construct / validate a config without repeating the shape. `run`'s first argument is inferred from the schema — no separate type declaration.

### Subscribe usage

Three shapes:

```ts
// Match-any: bare event as Source
await trigger({
  on: taskCompleted,
  do: launchAgent({ agentId: A.id }),
});

// Filtered: .where narrows the match
await trigger({
  on: taskCompleted.where({ taskId: X.id }),
  do: launchAgent({ agentId: A.id }),
  oneShot: true,                  // default is true; shown for clarity
});

// Multiple filter dimensions: .where takes one key per declared filter, all optional
await trigger({
  on: pushLanded.where({ repoId: "r1", minFilesChanged: 5 }),
  do: launchAgent({ agentId: A.id }),
});
```

### Filter semantics

**Plain column (the 95% case).** Default match is `col IS NULL OR col = payload[key]`. Subscribing with a value filters; subscribing without one (NULL) matches every emit.

```ts
filters: {
  taskId: text("task_id").references(() => _tasks.id, { onDelete: "cascade" }),
}
// trigger({ on: taskCompleted.where({ taskId: "X" }), ... })   → task_id='X' in row
// trigger({ on: taskCompleted, ... })                          → task_id=NULL in row (match-any)
// emit({ taskId: "X" }) matches rows where task_id IS NULL OR task_id = 'X'.
```

**Object form (when you need a non-identity predicate).** Each filter contributes one AND-ed predicate. Make each predicate null-tolerant on the column so NULL means "don't filter on this dimension":

```ts
filters: {
  minFilesChanged: {
    column: integer("min_files_changed"),
    match: (col, p) => or(isNull(col), gte(p.filesChanged, col)),
  },
}
```

**Cross-column (rare).** Override with top-level `matchFn`. When `matchFn` is set, per-filter `match` functions are ignored — it fully owns the WHERE clause.

### Cleanup semantics

**`action.deleteTargeting(configMatch)`** — iterates the trigger-table registry (populated at module load by each `defineTriggerEvent` call). For each table, runs:

```sql
DELETE FROM <table>
 WHERE action_name = $1
   AND action_config @> $2::jsonb     -- JSONB containment
```

`@>` ensures `launchAgent.deleteTargeting({ agentId: A })` matches rows whose `action_config` contains `agentId: A`, regardless of other keys in the config. Use from a plugin's delete handler whenever the target of any action is removed. `configMatch` is typed against the action's config, so typos fail at compile time.

**`deleteTrigger(id)`** — UUIDs are unique across tables, so iterate the registry and `DELETE FROM <table> WHERE id = $1` on each. The first match deletes; the rest are no-ops. No reverse lookup needed.

## Storage model

### Base columns (shared by every trigger table)

Applied automatically inside `defineTriggerEvent`:

| Column | Type | Notes |
|---|---|---|
| `id` | uuid, PK, default random | Row identifier |
| `action_name` | text, not null | Looked up in action registry |
| `action_config` | jsonb, not null | Passed to handler |
| `enabled` | boolean, not null, default true | Soft-disable without delete |
| `one_shot` | boolean, not null, default true | Delete after fire |
| `created_at` | timestamptz, not null, default now() | For debugging / ordering |

### Per-event filter columns

Declared by the plugin owning the event. Filter columns should be **nullable** so NULL means "match any on this dimension". If the column references a domain table, add `onDelete: "cascade"`.

### Indexes

For each declared filter column, `defineTriggerEvent` auto-creates a partial index:

```sql
CREATE INDEX <table>_<col>_idx ON <table>(<col>) WHERE enabled;
```

Keeps the dispatch query O(matches) even with thousands of disabled rows.

### Generated table example

```ts
// In plugins/tasks-core/server/internal/tables.ts
export const { event: taskCompleted, table: _taskCompletedTriggers } =
  defineTriggerEvent<{ taskId: string; parentId: string | null; status: "success" | "failure" }>({
    name: "tasks.completed",
    filters: {
      taskId: text("task_id").references(() => _tasks.id, { onDelete: "cascade" }),
    },
  });
```

Produces this table (roughly):

```sql
CREATE TABLE task_completed_triggers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action_name text NOT NULL,
  action_config jsonb NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  one_shot boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  task_id text REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE INDEX task_completed_triggers_task_id_idx
  ON task_completed_triggers(task_id) WHERE enabled;
```

## Dispatch

### `event.emit(payload)` query path

```sql
SELECT * FROM <table>
 WHERE enabled AND <match-expression>;
```

Where `<match-expression>` is the AND of every filter's predicate (or the `matchFn` override). For each returned row:

1. Look up `row.action_name` in the in-memory action registry.
2. If not found: log a warning, do **not** delete the row. (A later `defineAction` with the same name can still service it.)
3. If found: run `schema.safeParse(row.action_config)`.
   - **Parse failure** → log a warning with the zod error, do **not** invoke the handler, do **not** delete the row (same preservation policy as unknown-action). The row is a drift artifact; fixing the stored config or reverting the schema recovers it.
   - **Parse success** → call `handler(parsed, { payload, triggerId: row.id, table })`. Any thrown error → log and continue.
4. If `row.one_shot === true` and the handler ran successfully: delete the row by id.

Rows are processed in parallel (`Promise.all`). No ordering guarantee between subscribers.

### No cross-process coordination

A single Bun process per worktree runs everything. No locks, no leader election. `emit` is called in-process from the mutation site.

### Unknown-action handling

`defineAction` is idempotent at module load. If a trigger row references an action whose plugin was removed, dispatch logs and skips without deleting — the row is preserved so re-adding the plugin later picks up existing triggers. Same preservation policy applies to config parse failures (see dispatch step 3): drift is a recoverable situation, not a reason to destroy rows.

## Emit-site discipline

**The one load-bearing contract.** The plugin that owns the state emits from the same function that mutates it. Same pattern as `resource.notify()`.

Concrete sites for v1:

- **`taskCompleted`** — task completion is derived in the `tasks_v` view from completed attempts, not a single column flip. Emit from each write that *causes* the not-done→done transition: `insertPush(...)` in [`plugins/tasks-core/server/internal/mutations/pushes.ts`](../plugins/tasks-core/server/internal/mutations/pushes.ts), and `updateTask({ drop: true })` in [`plugins/tasks-core/server/internal/mutations/tasks.ts`](../plugins/tasks-core/server/internal/mutations/tasks.ts). Each emitter must re-derive the task's status post-write and only emit on the transition (not on already-done writes).

- **`conversationCompleted`** — conversation `status` is a real column. Emit from the poller at [`plugins/conversations/server/internal/poller.ts:92`](../plugins/conversations/server/internal/poller.ts) right after `await updateConversation(id, { status: "gone", endedAt: new Date() })`.

If a future code path mutates state outside the plugin's API and skips the emit, no event fires. That is a caller bug, not a framework gap — the same contract every resource in the codebase already has.

## File layout

```
plugins/events/
└── server/
    ├── index.ts                    # Public API: defineTriggerEvent, defineAction,
    │                               # trigger, deleteTrigger,
    │                               # default export = ServerPluginDefinition
    └── internal/
        ├── base-columns.ts         # eventTriggerColumns() — shared column set
        ├── registry.ts             # action map + trigger-table registry (Map<name, PgTable>)
        ├── source.ts               # EventSource shape, .where builder
        └── dispatch.ts             # runAction(row, payload, table): lookup, call, oneShot-delete

plugins/tasks-core/
└── server/
    ├── index.ts                    # re-export: export { taskCompleted } from "./internal/tables"
    └── internal/
        ├── tables.ts               # existing tables + defineTriggerEvent calls for
        │                           # taskCompleted + conversationCompleted (destructured exports)
        └── mutations/
            ├── tasks.ts            # emit taskCompleted on derived transition
            └── pushes.ts           # emit taskCompleted after attempt completion

plugins/agents/
└── server/
    ├── index.ts                    # export const launchAgent = defineAction({...}) at module load
    └── internal/
        └── handle-launch.ts        # existing launch code wrapped by the action

plugins/conversations/
└── server/
    └── internal/
        └── poller.ts               # emit conversationCompleted after gone-transition

server/src/
├── db/schema.ts                    # add: export * from "@plugins/tasks-core/server/internal/tables"
│                                   # (already there; confirm new tables are re-exported)
└── plugins.ts                      # add: eventsPlugin to the plugins list
```

## Why `defineTriggerEvent` returns `{ table, event }`

drizzle-kit walks `server/src/db/schema.ts` and checks each **named export** for the drizzle PgTable brand. It does not recurse into nested properties. So if only the event object is exported and the table is hidden at `event.table`, drizzle-kit never sees it and no migration is generated.

Destructure at the call site:

```ts
export const { event: taskCompleted, table: _taskCompletedTriggers } =
  defineTriggerEvent<TaskCompletedPayload>({ ... });
```

`_taskCompletedTriggers` is now a top-level `PgTable` export → auto-registered via the existing `export * from "@plugins/tasks-core/server/internal/tables"` barrel line. `taskCompleted` is the event handle, re-exported from `index.ts` for other plugins.

## Implementation steps

Ordered to keep each step independently buildable / testable.

1. **Scaffold the events plugin.** Create `plugins/events/` with `package.json`, `server/index.ts` (empty `ServerPluginDefinition`), and `server/internal/` folder. Register in `server/src/plugins.ts`.
2. **Base columns + registry.** Implement `internal/base-columns.ts` and `internal/registry.ts`. Registry has two maps: actions (`name → { handler }`) and trigger tables (`name → PgTable`).
3. **Source + `defineTriggerEvent`.** Implement `internal/source.ts` with the `EventSource` shape and `.where()` builder. Export `defineTriggerEvent` from `index.ts`. It builds the table via `pgTable()` with base columns spread + declared filters, auto-generates partial indexes, registers the table, and returns `{ table, event }`. The `event` is both an `EventSource` (`__kind: "event"`, opaque source fields) and an object with `.emit(payload)`, `.where(filter)`, `.name`. `.emit` runs the dispatcher; `.where(filter)` returns a new `EventSource` carrying the accumulated filter values.
4. **`defineAction`.** Export from `index.ts`. The returned factory is a function `(config) => ActionRef` with `.name`, `.schema`, and `.deleteTargeting(match)` attached. At call time it registers the handler *and the schema* in the action map (error on duplicate name). The dispatcher reads the schema from this map to validate `action_config` before invoking the handler.
5. **`trigger`.** Export from `index.ts`. Inspects `on.__kind` (only `"event"` in v1), extracts `on.table` and `on.filter`, extracts `do.name` and `do.config`, inserts one row with filter columns + `action_name` + `action_config` + `one_shot`. Returns the inserted row id.
6. **Dispatcher.** Implement `internal/dispatch.ts` with `runAction(row, payload, table)` — registry lookup, handler call (try/catch, log on error), oneShot delete.
7. **Cleanup helpers.** `deleteTrigger(id)` iterates the trigger-table registry. `action.deleteTargeting(match)` is attached to each action factory at `defineAction` time and runs the JSONB-containment delete across the registry.
8. **Wire up `taskCompleted`.** In `plugins/tasks-core/server/internal/tables.ts`, call `defineTriggerEvent` for `taskCompleted`. Destructure to top-level `event` + `table` exports. Re-export `taskCompleted` from `plugins/tasks-core/server/index.ts`.
9. **Wire up `conversationCompleted`.** Same pattern, in the same file.
10. **Emit sites.** Add emits in `mutations/pushes.ts`, `mutations/tasks.ts`, and `poller.ts` per the emit-site-discipline section. Each emitter re-derives state post-write and only emits on the relevant transition.
11. **Define `launchAgent`.** In `plugins/agents/server/index.ts`, `export const launchAgent = defineAction({ name: "agents.launch", config: z.object({ agentId: z.string(), prompt: z.string().optional() }), run: ... })` at module load.
12. **Delete-target cleanup.** In the agents plugin's agent-delete handler, call `launchAgent.deleteTargeting({ agentId })` before deleting the agent row.
13. **Build & migrate.** Run `./equin build` — drizzle-kit picks up the two new tables and generates a migration. Server restart applies it.

## Acceptance tests

Manual (exercise from a conversation):

1. **Single-event, one-shot.** Create task X. `trigger({ on: taskCompleted.where({ taskId: X.id }), do: launchAgent({ agentId: A.id }), oneShot: true })`. Complete X. Verify: agent A launches; the trigger row is deleted.
2. **Single-event, recurring.** Same subscription with `oneShot: false`. Complete + re-open + re-complete X. Verify: action fires twice; row persists.
3. **Match-any.** `trigger({ on: taskCompleted, do: launchAgent({ agentId: A.id }) })` (bare event, no `.where`). Complete any task. Verify action fires.
4. **FK cascade cleanup.** Subscribe with `taskCompleted.where({ taskId: X.id })`. Delete X. Verify the trigger row is gone (SQL: `SELECT * FROM task_completed_triggers WHERE task_id = 'X.id'` returns empty).
5. **Action-target cleanup.** Subscribe with `do: launchAgent({ agentId: A.id })`. Delete agent A via the agents plugin (which must call `launchAgent.deleteTargeting({ agentId: A.id })`). Verify the trigger row is gone.
6. **Unknown action.** Insert a trigger row by hand with `action_name: "nonexistent"`. Emit the matching event. Verify: log warning, no crash, row NOT deleted. Define the action, emit again — now it fires.
7. **Config drift.** Insert a trigger row by hand with `action_name: "agents.launch"` and `action_config: { wrongKey: "x" }`. Emit the matching event. Verify: log warning with zod error, handler NOT invoked, row NOT deleted. Update the row's config to a valid shape, emit again — now it fires.
8. **Index usage.** With 5k rows in `task_completed_triggers` across 100 distinct `task_id` values, `EXPLAIN` the dispatch query — must be `Index Scan` on the partial index, not `Seq Scan`.

Unit-level:

- `defineTriggerEvent` type inference: `match` callback's payload typed as `T`; `.where({...})` filter keys typed against `F`; column arguments typed against the bound table.
- `defineAction` type inference: `launchAgent(...)` config typed against `z.input<Schema>`; `run`'s first arg typed against `z.infer<Schema>`; `launchAgent.deleteTargeting(...)` match typed as `Partial<z.infer<Schema>>`.
- `defineAction` runtime validation: a stored `action_config` that fails `schema.safeParse` skips dispatch, logs, preserves the row.
- `trigger({ on, do })` against an empty table: inserts one row.
- `event.emit(payload)` against an empty table: no-op, no errors.
- `runAction` with unknown `action_name`: log-only; row preserved.
- `action.deleteTargeting` only deletes rows whose `action_config` contains every key in the match object (JSONB `@>` semantics), not a superset.
