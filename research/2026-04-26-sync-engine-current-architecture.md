# Current sync engine: architecture reference

Self-contained snapshot of how equin's data/sync layer works **today**. Companion to:

- `research/2026-04-26-sync-engine-issues.md` — the pain points being addressed.
- `research/2026-04-26-sync-design-{1..5}-*.md` — the five sub-design plans.

This doc exists so an agent iterating on a sub-design doesn't have to re-explore the codebase. Every claim cites a real file. If something here disagrees with the code, the code wins — open a PR to fix the doc.

---

## 1. The five surfaces

A plugin author who wants a piece of data to appear in the UI touches **five** things today:

1. **A Drizzle table** in `plugins/<name>/server/internal/tables.ts` — physical schema.
2. **A `defineResource(...)`** in `plugins/<name>/server/internal/resources.ts` — server-side live state primitive (loader + mode + optional `dependsOn`).
3. **A `resourceDescriptor<T>(key)`** in `plugins/<name>/shared/...` — type-only stand-in so the web side can name the resource without importing server code.
4. **An `httpRoutes` map entry** for every mutation in `plugins/<name>/server/index.ts`, with a `(req, params) => Response` handler that writes the DB and calls `resource.notify()`.
5. **A `useResource(descriptor, params)` hook** on the client to read it, plus a hand-written `fetch('/api/...')` for every mutation.

The five are linked by **string keys** and **Zod schemas duplicated by hand**. Renaming a key breaks at runtime, not compile time. (This is issue #7 in the issue catalogue.)

---

## 2. Server-side: `defineResource`

### 2.1 The primitive

`server/src/resources.ts:90-151` defines:

```typescript
export type ResourceMode = "push" | "invalidate";
export type ResourceParams = Record<string, string>;

export interface ResourceDefinition<T, P extends ResourceParams = ResourceParams> {
  key: string;
  mode?: ResourceMode;                                 // default "invalidate"
  loader: (params: P) => Promise<T> | T;
  dependsOn?: ReadonlyArray<DependsOnEntry<P>>;
  onFirstSubscribe?: (params: P) => void | Promise<void>;
  onLastUnsubscribe?: (params: P) => void;
}

export interface Resource<T, P extends ResourceParams = ResourceParams> {
  key: string;
  mode: ResourceMode;
  load(params: P): Promise<T>;
  notify(params?: P): void;
}

export function defineResource<T, P>(def: ResourceDefinition<T, P>): Resource<T, P>;
```

`mode`:
- **`"push"`** — when `notify()` fires, the server calls the loader and broadcasts `{kind: "update", key, params, value, version}` to every subscriber.
- **`"invalidate"`** — when `notify()` fires, the server broadcasts `{kind: "invalidate", key, params, version}` and each client refetches over HTTP. Loader is *not* called server-side on notify.

`params` is **always `Record<string, string>`** — flat string-only map, encoded into the URL query string for the HTTP fallback. There is no provision for nested or non-string params.

`dependsOn` is an array of `{ resource, map? }`. When an upstream resource notifies, the engine schedules notifies on each downstream entry, with optional `map: (upstreamParams, upstreamValue) => downstreamParams[]` for param projection. If `map` is omitted, the upstream's params are forwarded as-is.

`onFirstSubscribe` / `onLastUnsubscribe` fire on the **0→1** and **N→0** *global* refcount transitions for a given params tuple, counted across every open socket. A socket closing releases the refs it held.

### 2.2 The registry, scheduler, and DAG

The server keeps a single in-process registry (`registry: Map<string, RegistryEntry>`, `server/src/resources.ts:79`). Each entry tracks:

- `versions: Map<paramsKey, number>` — monotonic per `(key, params)` tuple.
- `pendingNotifies: Map<paramsKey, ResourceParams>` — coalesced pending notifies.
- `subCounts: Map<paramsKey, number>` — global refcount.
- `upstreamKeys: string[]` and `downstream: DownstreamEdge[]`.

A topological order over the dependsOn DAG is rebuilt lazily when needed (`rebuildDag`, line 155). Cycles are detected and **warned only** (phase 1) — the doc says "phase 3 promotes this to a hard failure" but it has not been promoted.

`scheduleNotify` (line 228) puts the notify into `pendingNotifies` and queues a `flushNotifies` on the next microtask. Multiple notifies for the same `(key, params)` within a microtask coalesce.

`flushNotifies` (line 235) iterates `topoOrder` upstream-first; for each pending notify it:

1. Bumps the version.
2. If anyone is subscribed AND `mode === "push"` (or any downstream `map` needs the value), runs the loader.
3. Sends `update` (push) or `invalidate` to each subscribed socket.
4. Cascades into downstream entries by writing into *their* `pendingNotifies`. Because the iteration is upstream-first within the same loop, the cascade is picked up later in the same flush.

If the loader throws during a notify, the entry is **skipped entirely** — no broadcast, no cascade, "to avoid invalidating downstream state based on a torn read" (`server/src/resources.ts:264-269`).

### 2.3 The WebSocket handler

`notificationsWsHandler` (`server/src/resources.ts:312-357`) is mounted at `/ws/notifications` (a single shared socket per tab; see §3). Per socket:

- `state.subs: Map<key, Map<paramsKey, ResourceParams>>` — what this socket has subscribed to.
- A 20-second `ping` heartbeat from server to client. Client sends `pong` (server ignores it).

Client → server messages:

```json
{ "op": "sub",   "id": 1, "key": "tasks", "params": {} }
{ "op": "unsub", "key": "tasks", "params": {} }
```

Server → client messages (`plugin-core/notifications-client.ts:24-29`):

```typescript
type ServerMsg =
  | { kind: "sub-ack";    id?: number; key; params; value; version }
  | { kind: "update";     key; params; value; version }
  | { kind: "invalidate"; key; params; version }
  | { kind: "sub-error";  id?: number; key; reason }
  | { kind: "ping" };
```

`handleSub` (line 359) is the initial-snapshot path: on a fresh sub, it runs the loader, bumps the version, and sends `sub-ack` carrying value+version. The same loader call paths run again on each subsequent push notify.

### 2.4 The HTTP fallback

`handleResourceHttp` at `GET /api/resources/:key?<params>` (`server/src/resources.ts:441-467`) returns `{ value, version }` JSON. This is what `useResource`'s `queryFn` calls when:

- The WS isn't open yet on first paint.
- The WS dropped and queries refetched.
- A server-side or curl call wants the raw resource value.

The HTTP path runs the loader from scratch each call — there's no caching.

There's also a debug endpoint (`/api/resources/_debug`, line 469) that dumps `topoOrder`, per-entry subscriber counts, versions, and dependsOn edges as JSON. (No UI consumes it yet — see issue #15.)

---

## 3. Client-side: `useResource` and `NotificationsClient`

### 3.1 `resourceDescriptor` — the type bridge

`plugin-core/shared/resource.ts`:

```typescript
export interface ResourceDescriptor<T, P> {
  key: string;
  readonly __types?: { value: T; params: P };  // phantom types, never set
}

export function resourceDescriptor<T, P>(key: string): ResourceDescriptor<T, P>;
```

The descriptor is a **type-erased value** that carries only the string key at runtime; the `T` and `P` generics are phantoms that the client uses for inference. The server's `Resource<T, P>` and the shared `ResourceDescriptor<T, P>` are linked **only** by the matching string key (and the convention that the author kept the types in sync).

In practice today, plugins export a server-side `Resource<T>` value (e.g. `tasksResource` from `plugins/tasks-core/server`) and the web side imports it directly — the type comes through naturally because the web tsconfig can see the server file's exported types. The descriptor pattern was the original design; some plugins have migrated past it and just import the resource value for its type. (This works because the web side never *calls* the loader; only the `key` and types are needed.)

There is a hard rule encoded in the `useResource` source itself (`plugin-core/use-resource.ts:58-62`) and enforced by `./equin check --no-use-resource-cast`:

> Never cast the `data` returned by `useResource` (e.g. `data as Foo[]`). The generic `T` is inferred from the descriptor — casting silently hides type mismatches. STOP and report instead.

### 3.2 `useResource`

`plugin-core/use-resource.ts:63-95`:

```typescript
export function useResource<T, P>(
  resource: ResourceDescriptor<T, P>,
  params?: P,
): UseQueryResult<T> {
  const notifications = useContext(NotificationsContext);
  const key = resource.key;
  const p = (params ?? {}) as ResourceParams;

  useEffect(() => {
    notifications.observe(key, p);
    return () => notifications.unobserve(key, p);
  }, [notifications, key, JSON.stringify(p)]);

  return useQuery<T>({
    queryKey: queryKeyFor(key, p),
    queryFn: async () => {
      const qs = new URLSearchParams(p).toString();
      const url = `/api/resources/${encodeURIComponent(key)}${qs ? `?${qs}` : ""}`;
      const res = await fetch(url);
      const body = await res.json() as { value: T; version: number };
      return body.value;
    },
  });
}
```

It's a thin wrapper around TanStack Query. `staleTime: Infinity`, `refetchOnWindowFocus: false`, `refetchOnReconnect: false` are hard-set in `getDefaultQueryClient` (line 17–34) — the WS push path is the only thing that updates cached data after the initial load.

Subscription bookkeeping is refcounted: multiple components reading the same `(key, params)` share one server subscription.

### 3.3 `NotificationsClient`

`plugin-core/notifications-client.ts:51-159` — a singleton per tab, instantiated in `NotificationsProvider`. It owns one `SharedWebSocket('/ws/notifications')`, which is leader-elected across tabs (one tab opens the actual socket; others piggyback via `BroadcastChannel`).

On the wire side:

- `observe(key, params)` increments a refcount; on 0→1 it sends `{op: "sub", id, key, params}`.
- `unobserve(...)` decrements; on 1→0 it sends `{op: "unsub", key, params}`.
- On each WS open (fresh, leader handoff, server restart), `replaySubs` resends every active subscription with `version = 0`.
- Incoming `sub-ack` and `update` both call `applyUpdate` → `queryClient.setQueryData(queryKeyFor(key, params), value)`.
- Incoming `invalidate` calls `queryClient.invalidateQueries(...)`, which triggers TanStack to refetch via the `queryFn` → HTTP fallback.
- All apply paths drop messages where `version <= entry.version` (stale guard).

The reset-to-version-zero on reconnect (line 98–101) is required: the server's per-connection state is gone, and a new `sub-ack` may carry a *lower* version (server restart). Without resetting, the new ack would be filtered as stale.

`SharedWebSocket` itself (`plugin-core/shared-websocket.ts`) is a separate primitive; cross-tab leader election lives there, not in the notifications client.

---

## 4. HTTP routes — the parallel write surface

### 4.1 Plugin shape

Each server plugin default-exports:

```typescript
const plugin: ServerPluginDefinition = {
  id: "agents",
  name: "Agents",
  httpRoutes: {
    "GET /api/agents":           handleList,
    "POST /api/agents":          handleCreate,
    "GET /api/agents/:id":       handleGet,
    "PATCH /api/agents/:id":     handleUpdate,
    "DELETE /api/agents/:id":    handleDelete,
    "POST /api/agents/:id/launch": handleLaunch,
  },
  wsRoutes: { "/ws/foo": handler },         // optional
  resources: [agentsResource],              // optional; auto-mounts
};
export default plugin;
```

`server/src/index.ts` flattens every plugin's routes into two lookup tables. Literal paths match in O(1); paths with `:param` segments match linearly in registration order, with captured params passed as the second arg to the handler.

```typescript
export type HttpHandler = (req: Request, params: Record<string, string>) => Response | Promise<Response>;
```

There is **no middleware layer**. Auth, logging, rate-limiting, request validation — none of these exist. Each handler does its own request parsing.

### 4.2 A representative mutation handler

`plugins/agents/server/internal/handle-create.ts`:

```typescript
export async function handleCreate(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as {
    parentId?: string | null;
    name?: string;
    prompt?: string | null;
    model?: string | null;
  };
  const id = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const parentId = body.parentId ?? null;
  const rank = await nextAgentRankUnder(parentId);
  const [row] = await db.insert(_agents).values({ id, parentId, /* ... */ rank }).returning();
  if (parentId) {
    await db.update(_agents).set({ expanded: true, updatedAt: new Date() }).where(eq(_agents.id, parentId));
  }
  agentsResource.notify();   // <-- the entire reactivity contract sits in this one line
  return Response.json(row);
}
```

Note what's missing:

- No request schema validation. `body.title` would be `undefined` instead of erroring; field-by-field `typeof x !== "string"` checks are written out by hand in handlers that bother to validate.
- No transaction wrapping the insert + update. If the second `update` throws, the insert has already committed.
- The `notify()` is **post-commit, not in-transaction**. There is no guarantee that two interleaved mutations produce a consistent snapshot across notifies.
- The error shape is whatever the author chose: `Response.json({error: "..."}, {status: 400})` vs `new Response("Missing id", {status: 400})` vs thrown exceptions. Clients string-match.

### 4.3 Client invocation

The client side is plain `fetch`:

```typescript
async function createAgentRow(args: {...}): Promise<string | null> {
  const res = await fetch("/api/agents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...args, name: "New agent", prompt: "" }),
  });
  if (!res.ok) return null;
  const agent = await res.json() as Agent;
  return agent.id;
}
```

There is no shared mutation primitive, no optimistic-update wrapper, no TanStack `useMutation` convention. Optimism, when it exists, is per-component `useState` shadow copies that get reconciled when the WS push lands.

---

## 5. Multi-resource cascading: a real example

`plugins/tasks-core/server/internal/resources.ts` defines four resources with a deliberate dependency chain:

```typescript
export const recentConversationsResource = defineResource({ key: "conversations", mode: "push", loader: ... });

export const pushesResource = defineResource({ key: "pushes", mode: "push", loader: ... });

export const attemptsResource = defineResource({
  key: "attempts",
  mode: "push",
  dependsOn: [{ resource: recentConversationsResource }, { resource: pushesResource }],
  loader: async () => {
    const [attemptRows, convRows] = await Promise.all([...]);
    // ... build per-attempt conversation map
  },
});

export const tasksResource = defineResource({
  key: "tasks",
  mode: "push",
  dependsOn: [{ resource: attemptsResource }],
  loader: ...
});
```

The chain reads: `conversations` and `pushes` flow into `attempts`, which flows into `tasks`. A notify on either upstream cascades through `attempts` and on into `tasks`, and `flushNotifies` runs each loader once per (key, params) per microtask flush.

Two things to notice:

1. **Each loader re-runs from scratch.** `attemptsResource` re-joins all attempts and conversations on every change, even if the change is one row in a thousand-row payload. (Issue #13.)
2. **The `dependsOn` edges are hand-asserted.** If `attemptsResource`'s loader started reading the `pushes` table directly without `dependsOn` listing `pushesResource`, it would silently fail to update when pushes change. The type system can't catch it. (Issue #2.)

Fan-out from a single mutation often hits **multiple** notifies, hand-written. `plugins/tasks-core/server/internal/mutations/cross-table.ts:64-67`:

```typescript
// adoptOrphanConversation
tasksResource.notify();
attemptsResource.notify();
recentConversationsResource.notify();
```

Cross-plugin notifies are common and explicit:

```typescript
// plugins/conversations/server/internal/handle-create.ts
const session = await createConversation({ ... });
recentConversationsResource.notify();   // notifying tasks-core's resource from the conversations plugin
```

This is one of the load-bearing tensions today: plugin boundary rules forbid plugins reaching into each other's internals, but the `notify()` API *requires* the writing plugin to know which other plugins' resources need to fire. (Issue #17.)

---

## 6. Database schema and migrations

(Sourced from `server/CLAUDE.md` § Database, plus `plugins/tasks-core/server/internal/tables.ts` and `server/src/db/migrate.ts`.)

### 6.1 Per-plugin schema files

- `plugins/<name>/server/internal/tables.ts` — physical tables, plain Drizzle definitions.
- `plugins/<name>/server/internal/schema.ts` — derived views, Zod schemas via `drizzle-zod`'s `createSelectSchema`, exported types.

```typescript
// tables.ts
export const _tasks = pgTable("tasks", { ... });

// schema.ts
export const tasks = pgView("tasks_v").as((qb) => qb.select({...}).from(_tasks).where(...));
export const TaskSchema = createSelectSchema(_tasks, { ... });
export type Task = z.infer<typeof TaskSchema>;
```

Drizzle's config (`drizzle.config.ts`) discovers schemas via glob `plugins/**/server/**/internal/{tables,schema}.ts` — there is **no central aggregator file**. New plugins drop in without edits outside the plugin. Constraint: those files must be pure drizzle-orm definitions with no Bun imports in their transitive closure (drizzle-kit's loader runs outside Bun).

`server/src/db/client.ts` exports `db = drizzle(sql)` **without** a schema object — the codebase uses `db.select().from(table)` style, not `db.query.<table>` relational queries. So no runtime schema aggregation is needed.

### 6.2 The migration runner

Migrations live in `server/src/db/migrations/`, named `YYYYMMDD_HHMMSS_<contentHash>__<slug>.sql`. The runner (`server/src/db/migrate.ts`) is intentionally simple:

1. Ensure `__singularity_migrations (hash PRIMARY KEY, file, applied_at)` exists.
2. Read applied hashes.
3. Warn (don't error) on any applied hash with no matching file (means a migration was rebased away after running).
4. Loop over migration files sorted by filename timestamp; for each whose hash isn't applied, run its SQL and insert the hash in a single transaction.

The hash-keyed naming scheme exists because **multiple agents working in parallel worktrees can each generate migrations**. Hash naming means no filename collisions; merging both branches lets each worktree apply whichever hashes are new. Application order may differ from a fresh DB — fine for additive migrations, breaks for non-commutative ones.

### 6.3 Worktree DB lifecycle

Each agent's worktree gets its own Postgres database, forked from the main `singularity` DB via `pg_dump | pg_restore` (`plugins/conversations/server/internal/db-fork.ts`). The fork carries forward both data and migration state. Forks defensively `DROP SCHEMA IF EXISTS drizzle CASCADE` to strip the pre-hash migration system's remnants.

This is **the only branching primitive in the system**. Inside one worktree, there is no notion of "speculate, then keep or throw away". (Issue #18.)

### 6.4 Schema-change workflow

```
edit plugins/<n>/server/internal/tables.ts
→ ./equin build
   ├── drizzle-kit generate (writes new SQL migration if any plugin schema changed)
   ├── server restarts → migrate.ts runs pending migrations
   └── frontend rebuilds, gateway notified
→ commit the generated SQL file
```

First build after a schema change requires `--migration-name <slug>`; subsequent builds with no schema change don't.

Drizzle-generated DDL is idempotent (`CREATE TABLE IF NOT EXISTS`, `DO $$ … EXCEPTION WHEN duplicate_object`), but **hand-written data migrations** (seed inserts, backfills) can double-apply relative to forked data. Prefer idempotent statements (`INSERT … ON CONFLICT DO NOTHING`, guarded `UPDATE`s) for any DML.

---

## 7. Append-only firehoses (the *non*-resource path)

Resources deliver **level state** (full snapshot, no deltas). Append-only streams — terminal output, log tails, jsonl viewer events — use **dedicated WS routes**, not resources:

```typescript
const plugin: ServerPluginDefinition = {
  wsRoutes: { "/ws/terminal": terminalHandler },
};
```

Raw `text/event-stream` SSE in TS is **forbidden**, enforced by `./equin check --no-raw-sse`. Raw `new EventSource(...)` and raw `new WebSocket(...)` are also forbidden (`--no-raw-event-source`, `--no-raw-websocket`). The only escape hatches are `SharedWebSocket` (for a leader-elected per-origin socket) and `ReconnectingEventSource` (only for consuming the gateway's external log SSE endpoint — *not* for plugin data flow).

This split is deliberate: the resources system models **observable state**, while WS streams model **events**. There is no current primitive that bridges the two (e.g. "give me the last 100 events plus subscribe to new ones as they arrive").

---

## 8. Cross-runtime structure: shared types

A plugin can have three runtimes, each a separate folder under `plugins/<name>/`:

- `web/` — frontend code. Compiled by web tsconfig.
- `server/` — backend code. Compiled by server tsconfig.
- `shared/` — types and pure functions usable from both.

The barrel rules (enforced by `./equin check --plugin-boundaries`):

- `plugins/<name>/<runtime>/index.ts` is the only cross-plugin entry point.
- Cross-plugin imports may only be `@plugins/<name>/{web,server,shared}` — no deep paths.
- Each `index.ts` may only contain imports, re-exports, type aliases, and a single `export default <definePlugin(...)>`. No logic, no side effects.
- Default-export imports (`import fooPlugin from "@plugins/foo/web"`) are only allowed in `web/src/plugins.ts` and `server/src/plugins.ts`.
- The cross-plugin import graph must be a DAG. Type-only imports count as edges.

Public exports of every plugin are listed in `docs/plugins.md`, kept in sync by `./equin check --plugins-doc-in-sync`.

---

## 9. What this means for the redesign

Concrete things a sub-design proposal will have to either preserve, replace, or break with:

1. **The five-surface problem is the headline pain.** Any redesign should aim for one author-facing primitive that drives DB shape, validation, server reads, mutations, and client hooks. (Drives sub-designs 1, 4.)

2. **`Record<string, string>` params are baked deep.** The HTTP fallback URL-encodes them; the topo-cascade keys on `JSON.stringify` of sorted keys; `useResource`'s effect dependency is `JSON.stringify(p)`. Loosening this touches every layer.

3. **`dependsOn` is the explicit reactive contract today.** Any auto-tracking reactive engine (Convex-style read-set capture, Materialite-style IVM) would replace `dependsOn`, but the existing four-resource `tasks-core` chain is the regression-test case. (Drives sub-design 2.)

4. **Push vs invalidate is a load-bearing distinction.** Push runs the loader on the server when notify fires; invalidate doesn't run anything until a client refetches. Any new wire protocol has to either preserve the choice or unify it deliberately. (Drives sub-design 3.)

5. **The microtask-coalesced flush + topo-walk is the existing scheduler.** Any new engine has to handle:
   - Coalescing redundant notifies on the same `(key, params)` within a tick.
   - Cascading through a DAG with cycle detection.
   - Skipping cascade on loader failure (avoiding torn reads).
   - Per-`paramsKey` versioning for stale-message filtering on the client.

6. **The `useResource` AGENT RULE is a tell.** The codebase has been bitten enough by descriptor/loader type drift that there's a dedicated lint preventing the cast escape hatch. Any redesign should make the cast unnecessary, not just disallowed.

7. **There is no middleware, no caller context, no transaction handle threaded through anything.** Adding any of these is a structural change to handler signatures and resource loaders both. Sub-design 5 calls this an `OpCtx` primitive; it's a new first arg everywhere.

8. **The `./equin check` set is the enforcement layer.** New rules (e.g. "every mutation must funnel through `runMutation`", "no raw `notify()` calls outside the framework") would be added there.

9. **Worktree DB forking is the only branching primitive.** Inside one worktree there is no speculation, no undo. Any sub-design that proposes event-sourcing or a mutation log adds a new persistent table (`_mutation_log`, `_branches`) alongside `__singularity_migrations`.

10. **Single Bun process per worktree.** The registry, the WS broker, and the job runner all share one event loop. Any cross-process broadcast (Postgres LISTEN/NOTIFY, Redis pub/sub) is greenfield.
