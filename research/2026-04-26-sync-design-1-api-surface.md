# Sync engine sub-design 1 — Developer-facing API surface

> Scope: this doc explores **what a plugin author writes** to declare a piece of synchronised data (read + write + cache + types). It deliberately leaves the wire protocol, reactivity engine, and cache layer to sibling sub-designs. Issues addressed: **#6** (parallel untyped HTTP layer), **#7** (descriptor / type-bridge dance), **#17** (plugin boundary leakage), **#20** (two systems pretending to be one).

## 1. Problem restatement

Today an equin plugin author who wants to expose *one* piece of data writes **five** things in lock-step:

1. A Drizzle table in `<plugin>/server/internal/tables.ts`.
2. A `defineResource({ key: "foo", loader, dependsOn })` on the server, with a hand-written `dependsOn` graph and a manual `.notify()` call from every mutation site.
3. A `resourceDescriptor<T>("foo")` in `shared/`, whose only job is to carry the payload type to the web side without dragging a server import — the two declarations agree only on a string.
4. A handler under `httpRoutes: { "POST /api/foo": handleCreate }`, which parses `req.json().catch(() => ({}))`, validates ad-hoc, writes the DB, then `notify()`s — and is reached from the client by `fetch('/api/foo', { method: 'POST', body: JSON.stringify(...) })`, also un-typed.
5. A `useResource(descriptor, params)` call in a React component.

Reads are reactive (resources + WS). Writes are imperative (HTTP + manual notify). Both sides agree only by string. Renaming a key is a runtime break, not a compile error. We want **one primitive** — declare the data once, get reads + writes + types + transport for free.

## 2. Frameworks surveyed

### 2.1 tRPC

What the author writes ([trpc.io/docs/server/procedures](https://trpc.io/docs/server/procedures), [trpc.io/docs/client/react](https://trpc.io/docs/client/react)):

```ts
// server/router.ts
export const appRouter = router({
  hello: publicProcedure.query(() => ({ message: 'hello world' })),
  addMember: organizationProcedure
    .input(z.object({ email: z.string().email() }))
    .mutation((opts) => { /* … */ return '...'; }),
});
export type AppRouter = typeof appRouter;

// client/trpc.ts
export const trpc = createTRPCClient<AppRouter>({ links: [httpBatchLink({ url })] });

// component
const helloQuery = trpc.hello.useQuery({ name: 'Bob' });
const addMember = trpc.addMember.useMutation();
```

Design choices:

- **One unit, two flavours.** `.query()` and `.mutation()` are sibling builders on the same procedure object; the author picks the verb and gets the corresponding hook for free.
- **Type bridge is `typeof router`.** No descriptor file; the client imports the *type* of the server router as a single symbol.
- **Middleware is `.use(fn)` on the procedure builder**, immutable, chainable. Auth, logging, tx-scoping live here.
- **Modular composition** via nested routers (`router({ nested1: router({...}) })`) — sub-routers are first-class, so each plugin can own one and the root just merges them.
- **No reactivity.** Caching/invalidation is delegated to React Query keys derived from `(procedure, input)`. Mutations have to call `utils.invalidate(...)` by hand.

### 2.2 Convex

What the author writes ([docs.convex.dev/functions/query-functions](https://docs.convex.dev/functions/query-functions), [docs.convex.dev/functions/mutation-functions](https://docs.convex.dev/functions/mutation-functions)):

```ts
// convex/tasks.ts
export const getTaskList = query({
  args: { taskListId: v.id("taskLists") },
  handler: async (ctx, args) => {
    return await ctx.db.query("tasks")
      .withIndex("by_task_list_id", q => q.eq("taskListId", args.taskListId))
      .order("desc").take(100);
  },
});

export const createTask = mutation({
  args: { text: v.string() },
  handler: async (ctx, args) => ctx.db.insert("tasks", { text: args.text }),
});

// React
const tasks = useQuery(api.tasks.getTaskList, { taskListId });
const createTask = useMutation(api.tasks.createTask);
```

Design choices:

- **Reactivity is automatic and granular.** Convex tracks the *read set* of every query (which document IDs / index ranges it touched) and re-runs only queries whose read set intersects a mutation's write set ([Convex Architecture Deep Dive](https://makersden.io/blog/convex-architecture-deep-dive-reactive-database-functions-sync), [docs.convex.dev/realtime](https://docs.convex.dev/realtime)). No `dependsOn`, no manual `notify`.
- **The DB and the function runtime are one process.** Queries can only touch `ctx.db`; that's how the engine knows the read set.
- **Codegen `api.*`** — a generated module exposes typed handles to every function. The boundary between "function on disk" and "callable from React" is automated at build time.
- **Optimistic update is a first-class extension** ([docs.convex.dev/client/react/optimistic-updates](https://docs.convex.dev/client/react/optimistic-updates)):
  ```ts
  const inc = useMutation(api.counter.increment).withOptimisticUpdate(
    (localStore, args) => {
      const cur = localStore.getQuery(api.counter.get);
      if (cur !== undefined) localStore.setQuery(api.counter.get, {}, cur + args.increment);
    });
  ```
- **Three function kinds**: `query` (deterministic, reactive), `mutation` (transactional write), `action` (escape hatch with side effects, no reactivity contract).

### 2.3 React Server Components / Server Actions

What the author writes ([react.dev/reference/rsc/server-functions](https://react.dev/reference/rsc/server-functions)):

```ts
// actions.ts
"use server";
export async function updateName(name: string) {
  if (!name) return { error: 'Name is required' };
  await db.users.updateName(name);
}

// component
"use client";
import { updateName } from './actions';
function UpdateName() {
  const [state, submit, isPending] = useActionState(updateName, { error: null });
  return <form action={submit}><input name="name" disabled={isPending}/></form>;
}
```

Design choices:

- **The "RPC" is a module import.** The bundler rewrites `import { updateName }` from a `"use server"` file into a `react.server.reference` symbol; the runtime POSTs the args back to the server.
- **Types are real types**, because the import really is the function signature — no codec, no descriptor, no string key.
- **Asymmetric.** Reads are mostly RSC streaming (no client-side cache primitive in the spec); only writes have a clean Action story.
- **Per-function**, not per-domain. Composition is "just modules"; there is no router object to merge.

### 2.4 Replicache mutators

What the author writes ([doc.replicache.dev/concepts/how-it-works](https://doc.replicache.dev/concepts/how-it-works)):

```ts
// mutators.ts — runs in BOTH places
export const mutators = {
  createTodo: async (tx: WriteTransaction, todo: Todo) => {
    await tx.set(`/todo/${todo.id}`, todo);
  },
  markTodoComplete: async (tx, { id, complete }) => {
    const todo = await tx.get(`/todo/${id}`);
    if (todo) await tx.set(`/todo/${id}`, { ...todo, complete });
  },
};

// client
const rep = new Replicache({ mutators });
await rep.mutate.createTodo({ id: nanoid(), text: "trash" });

// server push endpoint runs the SAME mutator against canonical store
```

Design choices:

- **Same function, two transactions.** The mutator body is portable JS; the `WriteTransaction` is local on the client and authoritative on the server.
- **Optimism is structural**, not bolted on: the client transaction commits speculatively; subscriptions re-fire; the server transaction either confirms or rebases.
- **No server-defined queries.** Reads are arbitrary code over the local KV store via `tx.scan`; the server only ships deltas.
- **Wire boundary is just `push` + `pull`** — no per-mutator HTTP route, no per-resource invalidation key.

### 2.5 Zero (Rocicorp)

What the author writes ([zero.rocicorp.dev/docs/zero-schema](https://zero.rocicorp.dev/docs/zero-schema), [zero.rocicorp.dev/docs/writing-data](https://zero.rocicorp.dev/docs/writing-data)):

```ts
// schema.ts
const issue = table('issue').columns({
  id: string(), title: string(), authorID: string(),
}).primaryKey('id');
export const schema = createSchema({ tables: [issue, user], relationships: [...] });

// mutators.ts — shared
const updateIssue = defineMutator(
  z.object({ id: z.string(), title: z.string() }),
  async ({ tx, ctx: { userID }, args: { id, title } }) => {
    if (title.length > 100) throw new Error('Title is too long');
    await tx.mutate.issue.update({ id, title });
  });
export const mutators = defineMutators({ issue: { update: updateIssue } });

// client
const z = new Zero({ schema, mutators });
z.mutate(mutators.issue.update({ id: 'i1', title: 'New' }));
const issues = useQuery(z.query.issue.where('priority', 'high'));
```

Design choices:

- **Schema is the source of truth.** Tables, types, relationships flow from one `createSchema` call into both query and mutator types.
- **Custom mutators are typed RPCs** with a Zod arg schema and a `tx.mutate.<table>.<op>` API; the same function runs locally (optimistic) and on the server (canonical).
- **ZQL queries are declarative** (`z.query.issue.where(...)`), so the engine can compute the read set and incrementally maintain results.
- **`ctx.userID`** flows in via auth — mutators get a typed identity slot, not a `Request`.

### 2.6 TanStack Start server functions

What the author writes ([tanstack.com/start/latest/docs/framework/react/guide/server-functions](https://tanstack.com/start/latest/docs/framework/react/guide/server-functions), [tanstack.com/router/latest/docs/framework/react/start/server-functions](https://tanstack.com/router/latest/docs/framework/react/start/server-functions)):

```ts
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';

const UserSchema = z.object({ name: z.string().min(1), age: z.number().min(0) });

export const createUser = createServerFn({ method: 'POST' })
  .middleware([loggingMiddleware('createUser')])
  .inputValidator(UserSchema)
  .handler(async ({ data }) => `Created user: ${data.name}, age ${data.age}`);

// component
const user = await createUser({ data: { name: 'A', age: 1 } });
```

Design choices:

- **Builder chain over a config object** — `.middleware().inputValidator().handler()` is `defineFunction` in disguise, with each step refining the type.
- **Single function = single endpoint.** No router, no namespace; composition is at the module level.
- **Method intent (`'GET'` vs `'POST'`) is metadata** the framework reads to choose URL + cache semantics.
- **Reads vs writes are the same builder**, plus middleware chooses caching.

### 2.7 Phoenix LiveView / Hotwire (Turbo)

LiveView ([hexdocs.pm/phoenix_live_view](https://hexdocs.pm/phoenix_live_view/Phoenix.LiveView.html)):

```elixir
def render(assigns), do: ~H"""<button phx-click="inc">+</button> Counter: {@counter}"""
def handle_event("inc", _params, socket), do: {:noreply, update(socket, :counter, &(&1 + 1))}
def mount(_, _, socket), do: {:ok, assign(socket, counter: 0)}
```

Turbo Streams ([turbo.hotwired.dev/handbook/streams](https://turbo.hotwired.dev/handbook/streams)):

```html
<turbo-stream action="append" target="messages">
  <template><div id="message_1">…</div></template>
</turbo-stream>
```

Design choices:

- **No client model at all.** The "API surface" is HTML attributes; the framework owns the round-trip.
- **`phx-*` attributes** declare intents; the framework routes them to `handle_event/3` callbacks by name — no HTTP routes.
- **State lives server-side**; updates are diffs, not JSON. Optimism is whatever the client framework can fake on a button press.
- **Best-in-class for "just describe the UI, the wire goes away"** — but trades away the whole client-state model.

### 2.8 Hono RPC / Elysia Eden

Hono ([hono.dev/docs/guides/rpc](https://hono.dev/docs/guides/rpc)):

```ts
const route = app.post('/posts',
  zValidator('form', z.object({ title: z.string(), body: z.string() })),
  (c) => c.json({ ok: true, message: 'Created!' }, 201));
export type AppType = typeof route;

const client = hc<AppType>('http://localhost:8787/');
const res = await client.posts.$post({ form: { title: 'Hi', body: '…' } });
if (res.ok) console.log((await res.json()).message);
```

Elysia ([elysiajs.com/eden/treaty/overview](https://elysiajs.com/eden/treaty/overview)):

```ts
const app = new Elysia().post('/mirror', ({ body }) => body, {
  body: t.Object({ id: t.Number(), name: t.String() }),
});
export type App = typeof app;
const eden = treaty<App>('localhost:3000');
const { data, error } = await eden.mirror.post({ id: 1, name: 'x' });
```

Design choices:

- **HTTP is the surface, but typed.** The router still has methods + paths; the type bridge is `typeof app`.
- **Validators are middleware** (`zValidator`, `t.Object`) that refine the input type into the handler.
- **No reactivity, no cache** — these are typed RPC libraries, not sync engines. Useful as the "transport + types" layer under a richer cache.

## 3. Cross-framework comparison

| Framework | Read primitive | Write primitive | Type bridge | Plugin/module boundary | Optimistic | Learning curve |
|---|---|---|---|---|---|---|
| **tRPC** | `procedure.query()` + `useQuery` | `procedure.mutation()` + `useMutation` | `export type AppRouter` | Sub-routers merged at root | Manual (`utils.invalidate`) | Low–med |
| **Convex** | `query({ args, handler })` + `useQuery` | `mutation({ args, handler })` + `useMutation` | Generated `api.*` module | One file = one module of fns; `api.foo.bar` namespace | Built-in `withOptimisticUpdate` | Med (own DB) |
| **RSC / Server Actions** | RSC streaming (no cache primitive) | `"use server"` async fn | Function import = signature | Per-module; no router | `useOptimistic` hook | Low (looks like JS) |
| **Replicache** | `tx.scan` / `tx.get` in `subscribe` | Shared `mutator(tx, args)` runs both sides | Shared TS module | "Mutators object" registered at startup | Structural (speculative tx) | High (mental model) |
| **Zero** | `z.query.<table>.where(...)` | `defineMutator(zod, ({tx,ctx,args})=>…)` | `schema` + generated types | `defineMutators({ ns: { op } })` | Structural (local tx replays) | High |
| **TanStack Start** | `createServerFn({method:'GET'})` | `createServerFn({method:'POST'})` | Direct fn import | Per-module | Manual (Router cache) | Low |
| **LiveView** | `assigns` rendered in `~H` | `phx-click` → `handle_event` | One process owns view + state | Per-LiveView module | None (server is truth) | Med (Elixir + new model) |
| **Hono / Eden** | `app.get(...)` | `app.post(...)` | `typeof app` | Sub-apps `.route('/x', sub)` | None | Low |

Two clusters emerge:

- **RPC-shaped** (tRPC, Hono, Eden, TanStack, Server Actions): "describe a typed function, get a typed call site". Reactivity is bolted on (React Query, manual invalidation). Strong fit for equin's plugin model — a plugin owns a sub-router/module.
- **Database-shaped** (Convex, Zero, Replicache): "describe the data; reads, writes and reactivity fall out of one model". Reactivity is structural (read-set / write-set, or shared mutators). Strong fit for solving issues #1–#4 in one shot, but binds the API to one specific reactivity engine.

## 4. Options for equin

Three distinct shapes worth iterating on. None is final; each implies different commitments from the sibling sub-designs (reactivity, wire, cache).

### Option A — Plugin-router à la tRPC ("typed RPC + manual reactivity")

```ts
// plugins/agents/server/router.ts
export const agentsRouter = pluginRouter("agents", {
  list: query({
    input: z.object({ parentId: z.string().nullable().optional() }),
    handler: async ({ input, db }) => db.select().from(_agents)
      .where(input.parentId ? eq(_agents.parentId, input.parentId) : undefined),
    invalidatedBy: ["agents.*"], // tag-based reactivity
  }),
  create: mutation({
    input: AgentCreateSchema,
    handler: async ({ input, db, tx }) => {
      const id = `agent-${Date.now()}`;
      const rank = await nextAgentRankUnder(input.parentId ?? null);
      const [row] = await tx.insert(_agents).values({ id, ...input, rank }).returning();
      return row;
    },
    invalidates: ["agents.*"],
  }),
});

// plugins/agents/web — one import line, full types
import { useQuery, useMutation } from "@plugin-core/sync";
const agents = useQuery(api.agents.list, { parentId: null });
const create = useMutation(api.agents.create);
```

- **Pros.** Closest to today's mental model (handlers + payloads), lowest migration cost. Plugin owns one router; root composes them. Type bridge is `typeof agentsRouter`. Fixes #6 (one typed surface), #7 (no descriptor), #20 (one primitive).
- **Cons.** Reactivity stays tag-based (better than `dependsOn`, but still hand-declared). Doesn't solve #1/#13 deeply. Optimistic updates need a separate `withOptimisticUpdate`-style hook.
- **Plugin boundary.** Each plugin exports `agentsRouter`; cross-plugin reads call `api.tasks.get(...)` from inside a handler with the same typed surface.

### Option B — Convex-style colocated functions over Drizzle ("declare data, reactivity is automatic")

```ts
// plugins/agents/server/data.ts
export const agents = defineCollection({
  table: _agents, // Drizzle table = source of truth for types & schema
  queries: {
    listChildren: query({
      input: z.object({ parentId: z.string().nullable() }),
      handler: ({ input, q }) => q.from(_agents).where(eq(_agents.parentId, input.parentId)),
    }),
    byId: query({ input: z.string(), handler: ({ input, q }) => q.from(_agents).where(eq(_agents.id, input)).one() }),
  },
  mutations: {
    create: mutation({
      input: AgentCreateSchema,
      handler: async ({ input, m }) => {
        const id = `agent-${Date.now()}`;
        const rank = await nextAgentRankUnder(input.parentId);
        const [row] = await m.insert(_agents).values({ id, ...input, rank });
        if (input.parentId) await m.update(_agents).set({ expanded: true }).where(eq(_agents.id, input.parentId));
        return row;
      },
    }),
  },
});

// web
const children = useQuery(agents.listChildren, { parentId: null });
const create = useMutation(agents.create);
await create({ name: "x" }); // reactivity computed from read sets, no notify
```

The `q` and `m` handles are thin wrappers over Drizzle that record the touched tables/rows — that's the read/write set the reactivity engine uses (sub-design 2's job, not ours; we just commit to *exposing it through the API*).

- **Pros.** Solves #1–#4 in one stroke: no `dependsOn`, no `.notify()`, transactional writes are the default (`m.insert/update` lives inside one `tx`). Plugin author writes one description, gets reads + writes + reactivity + optimistic for free.
- **Cons.** Requires a Drizzle wrapper that can record read/write sets (non-trivial; some queries — raw SQL, joins across plugin tables — escape it). Cross-plugin reads need a story for "another plugin's collection". Big leap from today.
- **Plugin boundary.** A plugin exports its `Collection` object. Cross-plugin reads import the *type* of the other collection's queries; the registry sees only the value via the plugin definition, so leakage stays at the import level (already governed by boundary checks).

### Option C — Hybrid: typed RPC surface, opt-in "live query" superset

```ts
// plugins/agents/server/api.ts
export const agentsApi = pluginApi("agents", (p) => ({
  // boring RPC — replaces today's httpRoutes entirely
  rename: p.mutation({ input: z.object({ id: z.string(), name: z.string() }),
    handler: async ({ input }) => db.update(_agents).set({ name: input.name }).where(eq(_agents.id, input.id)) }),

  // declarative live query — replaces defineResource
  list: p.live({
    input: z.object({ parentId: z.string().nullable().optional() }),
    select: ({ input }) => db.select().from(_agents)
      .where(input.parentId ? eq(_agents.parentId, input.parentId) : undefined)
      .orderBy(asc(_agents.rank)),
    // schema-derived: framework knows this query reads `_agents` rows matching parentId
  }),
}));

// web
const agents = useLive(agentsApi.list, { parentId: null });   // reactive, granular
const rename = useMutation(agentsApi.rename);
```

- **Pros.** Honest about the two shapes: a `live` query is a *declarative* description over Drizzle (engine can analyse it), a `mutation` is an *imperative* function (engine can't, but doesn't need to — invalidation is derived from the writes inside). Doesn't force every read to be analysable; `query` (non-live) stays available as a fallback for "computed from the world" cases (#12: `findTranscriptPath`, git stats).
- **Cons.** Three primitives to teach (`query`, `live`, `mutation`) instead of two. The mental model is "use `live` when you can, `query` when you can't" — needs clear guidance. `live` is a constrained subset of Drizzle (no raw SQL, limited operators).
- **Plugin boundary.** Same as A — one router/api object per plugin, root composes.

## 5. Open questions (boundaries with sibling sub-designs)

These choices feed into / out of the other sub-designs and should not be fixed here:

- **Reactivity engine (sub-design 2).** Option A leaves it as tag invalidation; B requires read-set tracking; C is a mix. Whichever we pick, the API surface needs a vocabulary for "what changed" (tag list? row keys? table+predicate?).
- **Wire protocol (sub-design 3).** Does each query/mutation call its own URL (RPC over HTTP/2), or do we batch over WS? The API surface should be transport-agnostic — `useQuery(api.foo)` should not change shape if we swap transports.
- **Cache & store (sub-design 4).** Is there a normalised client cache (Convex, Apollo) or one cache entry per `(api.foo, input)` (React Query)? This affects whether mutation handlers can express "patch this row in collection X" or only "invalidate query Y".
- **Optimistic updates (sub-design 5).** `withOptimisticUpdate` (Convex) vs shared mutator that runs locally (Zero/Replicache) vs `useOptimistic` (RSC). The choice depends on whether mutators are pure-data writes (Zero) or arbitrary side-effecting code (today).
- **Auth / context (sub-design 6).** The `ctx` slot inside handlers (`ctx.userID` in Zero, `ctx.db` in Convex) is the obvious home for #9; what fields it carries depends on whether we ever grow multi-tenant.
- **Schema source of truth.** Drizzle today owns the DB schema; do we let it also own the input/output types of mutations (Drizzle-Zod), or keep request schemas separate? Affects #10 and #11.
- **Sub-router composition.** Do plugins export *one* router (Option A/C) or *N* collections (Option B)? Affects how cross-plugin calls type-check and how the `plugin-boundaries` check evolves.
- **Non-DB sources (#12).** Whichever option wins must leave a clean escape hatch for resources backed by the filesystem, git, or external services — likely an `action`-style primitive (Convex) where the engine makes no reactivity claim and the author calls `invalidate(...)` explicitly.

---

Sources:

- [tRPC procedures](https://trpc.io/docs/server/procedures)
- [tRPC React Query](https://trpc.io/docs/client/react)
- [tRPC routers](https://trpc.io/docs/server/routers)
- [Convex queries](https://docs.convex.dev/functions/query-functions)
- [Convex mutations](https://docs.convex.dev/functions/mutation-functions)
- [Convex optimistic updates](https://docs.convex.dev/client/react/optimistic-updates)
- [Convex realtime](https://docs.convex.dev/realtime)
- [Convex architecture deep dive](https://makersden.io/blog/convex-architecture-deep-dive-reactive-database-functions-sync)
- [React Server Functions](https://react.dev/reference/rsc/server-functions)
- [Replicache how it works](https://doc.replicache.dev/concepts/how-it-works)
- [Zero schema](https://zero.rocicorp.dev/docs/zero-schema)
- [Zero writing data](https://zero.rocicorp.dev/docs/writing-data)
- [Zero reading data](https://zero.rocicorp.dev/docs/reading-data)
- [TanStack Start server functions](https://tanstack.com/start/latest/docs/framework/react/guide/server-functions)
- [TanStack Router server functions](https://tanstack.com/router/latest/docs/framework/react/start/server-functions)
- [Hono RPC](https://hono.dev/docs/guides/rpc)
- [Elysia Eden Treaty](https://elysiajs.com/eden/treaty/overview)
- [Phoenix LiveView](https://hexdocs.pm/phoenix_live_view/Phoenix.LiveView.html)
- [Turbo Streams](https://turbo.hotwired.dev/handbook/streams)
