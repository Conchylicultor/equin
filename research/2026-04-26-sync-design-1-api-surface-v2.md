# Sync engine sub-design 1 (v2) — Developer-facing API surface

> Iteration on [`2026-04-26-sync-design-1-api-surface.md`](./2026-04-26-sync-design-1-api-surface.md). Same scope: **what a plugin author writes** to declare a piece of synchronised data. Same issues addressed (#6, #7, #17, #20). v1 surveyed the framework landscape and proposed three options (A: tRPC-style, B: Convex-style collections, C: hybrid live+rpc). This v2 picks one and pins down the concrete surface.
>
> Goal driving every decision below: **minimise the symbols a plugin author touches** and **collapse the mental model to two verbs** — read or write. Internal complexity (read-set tracking, wire format, optimistic engine, auth context) is the job of sub-designs 2–5; this doc commits to a *vocabulary* they have to honour, not implementations.

## 1. The recommendation in one paragraph

Pick **Option C** from v1, but **drop the third primitive** (`live`). With runtime read-set tracking on `ctx.db` (sub-design 2's job), the engine watches whatever the handler does — there is no need for a separate keyword to opt in. The plugin author writes `query` (reads, reactive) or `mutation` (writes, transactional). Both are declared inside one `definePluginApi("name", {...})` per plugin. Both are imported by name from React via `useQuery` / `useMutation`. End-to-end types flow from `typeof api` — no descriptors, no string keys, no parallel HTTP route map. **Five symbols total**: `definePluginApi`, `query`, `mutation`, `useQuery`, `useMutation`.

## 2. Why this beats the v1 options

| Concern | A (tRPC) | B (Collections) | C (3-verb hybrid) | **C-collapsed (this doc)** |
|---|---|---|---|---|
| Symbol count | 5 | 6+ | 6 | **5** |
| Verbs to teach | 2 (query/mutation) | 2 (namespaced under collection) | 3 (query/live/mutation) | **2** |
| Reactivity contract | Tag-based (`invalidatedBy:[…]`) | Read-set, automatic | Mixed: read-set for `live`, manual elsewhere | **Read-set + opt-in tags for non-DB** |
| Cross-plugin reactivity | Author tags both sides | Engine handles transparently | Engine handles for `live`, manual elsewhere | **Engine handles transparently** |
| Non-DB sources (#12) | Native (any handler) | Awkward (collection assumes table) | Native via `query` | **Native via `query` + `invalidatesOn` hint** |
| Migration cost from today | Low | High | Med | **Med** |
| Type bridge | `typeof appRouter` | Generated `api.*` | `typeof pluginApi` | `typeof pluginApi` |

The collapse from 3 → 2 verbs only works if the reactivity engine commits to runtime read-set tracking on `ctx.db`. Sub-design 2 is on the hook for this — but they're already on the hook *somewhere*; the collapse just removes the burden from the author of choosing whether their query qualifies for tracking. They write Drizzle; the engine instruments it.

## 3. The whole author-facing surface

### 3.1 Server: `definePluginApi` + `query` + `mutation`

```ts
// plugins/agents/server/api.ts
import { definePluginApi, query, mutation } from "@plugin-core/sync";
import { z } from "zod";
import { _agents } from "./internal/tables";
import { AgentCreateSchema, nextAgentRankUnder } from "./internal";

export const agentsApi = definePluginApi("agents", {
  list: query({
    input: z.object({ parentId: z.string().nullable() }).optional(),
    handler: ({ input, db }) =>
      db.select().from(_agents)
        .where(input?.parentId ? eq(_agents.parentId, input.parentId) : isNull(_agents.parentId))
        .orderBy(asc(_agents.rank)),
  }),

  byId: query({
    input: z.object({ id: z.string() }),
    handler: async ({ input, db }) => {
      const [row] = await db.select().from(_agents).where(eq(_agents.id, input.id));
      if (!row) throw new NotFound(`agent ${input.id}`);
      return row;
    },
  }),

  create: mutation({
    input: AgentCreateSchema,
    handler: async ({ input, tx }) => {
      const id = `agent-${Date.now()}`;
      const rank = await nextAgentRankUnder(input.parentId ?? null);
      const [row] = await tx.insert(_agents).values({ id, ...input, rank }).returning();
      if (input.parentId) {
        await tx.update(_agents).set({ expanded: true }).where(eq(_agents.id, input.parentId));
      }
      return row;
    },
  }),

  delete: mutation({
    input: z.object({ id: z.string() }),
    handler: ({ input, tx }) => tx.delete(_agents).where(eq(_agents.id, input.id)),
  }),
});

export type AgentsApi = typeof agentsApi;
```

### 3.2 Web: `useQuery` + `useMutation`

```tsx
// plugins/agents/web/components/AgentList.tsx
import { useQuery, useMutation } from "@plugin-core/sync";
import { agentsApi } from "@plugins/agents/shared";

export function AgentList({ parentId }: { parentId: string | null }) {
  const { data: agents, isLoading } = useQuery(agentsApi.list, { parentId });
  const createAgent = useMutation(agentsApi.create);

  if (isLoading) return <Spinner />;
  return (
    <>
      {agents.map((a) => <AgentRow key={a.id} agent={a} />)}
      <button onClick={() => createAgent({ parentId, name: "New" })}>+</button>
    </>
  );
}
```

### 3.3 Type bridge — one shared file, three lines

The web side cannot import from `server/` (boundary rule). Each plugin re-exports a type-only handle in `shared/`:

```ts
// plugins/agents/shared/api.ts
import { createApiClient } from "@plugin-core/sync";
import type { AgentsApi } from "../server/api"; // type-only — server file not bundled

export const agentsApi = createApiClient<AgentsApi>("agents");
```

`createApiClient` returns a typed Proxy keyed on the plugin name. Web code calls `useQuery(agentsApi.list, input)` — TanStack-style — and the framework resolves the wire path. **No string key in user code**; the only string is the plugin name in two places (server `definePluginApi("agents", …)` and shared `createApiClient<…>("agents")`), and those are checkable by `./equin check`.

(Codegen alternative: `./equin build` could write `shared/api.generated.ts` automatically. Out of scope for v1; the three-line file is acceptable as a starting point.)

### 3.4 The handler context

Two thin context shapes — and only two — are passed to handlers:

```ts
type QueryCtx = {
  input: Input;          // parsed by the input schema
  db: TrackedDb;         // instrumented Drizzle handle (read-only API)
  call: TypedCall;       // call other queries (NOT mutations)
  signal: AbortSignal;   // for long-running reads
};

type MutationCtx = {
  input: Input;
  tx: TrackedTx;         // instrumented transactional Drizzle handle (read+write)
  call: TypedCall;       // call other queries OR mutations (re-uses the same tx)
  emit(tag: string): void; // manual invalidation for non-DB writes
};
```

The split is physical:

- **`db` vs `tx`** makes the read/write distinction visible. A query cannot accidentally write — there's no insert/update/delete on `db`.
- **A mutation's body is one transaction by default**. The author doesn't wrap anything; `tx` is the transaction. Sub-design 4 owns the commit-and-emit semantics.
- **`call` is typed** because the cross-plugin api object carries types. From a query, only other queries are callable (compile-time enforced by the type of `call`). From a mutation, both are callable, and they share the enclosing tx.

## 4. Mapping today's five surfaces to the new two

| Today | New |
|---|---|
| Drizzle table in `tables.ts` | **Unchanged** — Drizzle still owns physical schema |
| `defineResource({ key, loader, dependsOn })` | `query({ input, handler })` inside `definePluginApi` |
| `resourceDescriptor<T>("foo")` in shared | One 3-line `shared/api.ts` (or codegen) |
| `httpRoutes: { "POST /api/foo": handler }` | `mutation({ input, handler })` in the same `definePluginApi` |
| `notify()` calls scattered everywhere | **Implicit** — engine derives from `tx` writes |
| `useResource(descriptor, params)` | `useQuery(api.foo.list, params)` |
| `fetch('/api/foo', {...})` | `useMutation(api.foo.create)` |

Five surfaces become two (`query`, `mutation`) + their two hooks. The Drizzle table stays — it's the physical schema, not part of the *API* surface.

The `notify()` collapse is the load-bearing simplification: today every mutation re-asserts which resources to invalidate (`tasksResource.notify(); attemptsResource.notify(); recentConversationsResource.notify();`). In the new world, the engine sees `tx.update(_attempts)…` and re-fires every `query` whose tracked read set touched `_attempts`. Issue #17 (plugin boundary leakage via cross-plugin notify) goes away by construction: the writing plugin never names the reading plugin's queries.

## 5. Escape hatches for non-DB sources

Issue #12 names three real cases that don't fit `ctx.db`: `findTranscriptPath` (filesystem), `git log` for commit stats (subprocess), and resources that watch a directory. Same primitive, with a manual hint:

```ts
transcriptPath: query({
  input: z.object({ conversationId: z.string() }),
  handler: ({ input }) => findTranscriptPath(input.conversationId),
  invalidatesOn: ({ input }) => [`fs:transcript:${input.conversationId}`],
}),
```

Anywhere a non-DB change occurs (filesystem watcher, job, external trigger):

```ts
import { Sync } from "@plugin-core/sync";
Sync.emit(`fs:transcript:${id}`);
```

The author writes `invalidatesOn` only when the engine *can't* see the read. Pure-DB queries (the common case) declare nothing.

The `Sync.emit` API is the same vocabulary that mutations could use via `ctx.emit("tag")` for non-DB writes — one tag namespace, two emission sites.

## 6. Optional features that don't grow the core

### 6.1 Optimistic updates

```ts
const createAgent = useMutation(agentsApi.create).optimistic((cache, input) => {
  cache.update(agentsApi.list, { parentId: input.parentId }, (rows) =>
    [...rows, { id: "tmp", ...input }]);
});
```

Convex-style — a single chained method on the hook, no new top-level symbol. Most plugins won't use it; the ones that do (drag-and-drop reorder, chip toggles, prompt input) opt in per call site. Sub-design 4 owns the `cache` API shape and rollback semantics.

### 6.2 Cross-plugin calls

```ts
// inside a tasks-core mutation handler
handler: async ({ input, tx, call }) => {
  const conv = await call(conversationsApi.create, { taskId: input.taskId });
  // …
}
```

`call` participates in the same tx, the same read-set ledger, and the same observability span. The author imports `conversationsApi` as a type via the existing `@plugins/conversations/shared` re-export — same boundary rule as today, no new mechanism.

## 7. What this commits the sibling sub-designs to

Every commitment below is a *vocabulary* requirement, not an implementation choice. Sub-designs 2–5 still pick how.

1. **Read-set tracking on `ctx.db` is the reactivity contract** (sub-design 2). If the engine cannot see what `db.select().from(_x).where(…)` reads, the v1→v2 collapse breaks. Whether tracking is row-level, range-level, or table-level is the engine's call.
2. **Mutation handler body = one transaction** (sub-design 4). `tx` is the only DB handle in scope; all writes inside the handler commit atomically; sync emissions fire as part of the commit.
3. **One typed wire per `(plugin, op, input)`** (sub-design 3). Whether it's RPC over HTTP/2, multiplexed over WS, or batched — the author surface is unaffected. `useQuery(api.foo.list, input)` must not change shape if the transport changes.
4. **`call` shares the enclosing operation** (sub-design 5). When mutation A calls mutation B, B inherits A's tx, A's actor identity (when one exists), and A's trace span. `call` is the *only* path between plugin APIs — direct imports of another plugin's handler functions are not part of the surface.
5. **Manual invalidation lives at one verb: `Sync.emit(tag)`** (sub-designs 2 + 5). Filesystem watchers, jobs, external webhooks all use the same tag namespace consumed by `query.invalidatesOn`.

## 8. Open questions

These four are not decided here; flagging them so the next iteration converges.

1. **One `definePluginApi` per plugin, or N collections?** Recommendation: **one**. It keeps the type bridge to one symbol (`typeof agentsApi`) and matches today's `definePlugin` shape. A plugin that has multiple logical groupings names them inside the api object (`{ agents: { list, create }, launches: { list, … } }`). Splitting into multiple top-level apis costs a `createApiClient` line per group with no real benefit.

2. **Streams (terminal, jsonl viewer, log channels).** Today these use dedicated `wsRoutes` outside the resources system. Three options:
   - **Leave as-is** — `wsRoutes` stays a separate primitive; the API is for observable state, not events. (Recommended for v1.)
   - **Add a third verb** `subscription({ source: () => AsyncIterable<T> })`. Grows the surface to 3.
   - **Polymorphic `query`** — handler may return a value or an async iterable. Cute but muddies the mental model.

3. **Naming.** `definePluginApi` vs `defineRouter` vs `pluginRouter` vs `defineSync` vs `defineApi`. Pick one. (Bias: `definePluginApi` mirrors `definePlugin` and `defineConfig` already in use.)

4. **Type bridge: shared file vs codegen.**
   - **Shared file** (3 lines per plugin) — explicit, reviewable, no new build step. Recommended for v1.
   - **Codegen** (`./equin build` writes `shared/api.generated.ts`) — zero author boilerplate but a new generated artefact to commit and a new failure mode (forgot to rebuild).

## 9. Out of scope (decided elsewhere)

- **Wire protocol, transport, replay log, reconnect semantics** — sub-design 3.
- **Read-set capture, IVM, payload granularity, query-result cache** — sub-design 2.
- **Optimistic engine internals, schema-as-source-of-truth, transactional commit-and-emit, validation pipeline** — sub-design 4.
- **`OpCtx` extensions: actor identity, observability, branching, multi-process broadcast** — sub-design 5.

The five symbols (`definePluginApi`, `query`, `mutation`, `useQuery`, `useMutation`) are the only contract this doc fixes. Everything else can change underneath without breaking plugin authors.
