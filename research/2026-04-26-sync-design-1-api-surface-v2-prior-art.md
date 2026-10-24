# Sync engine sub-design 1 (v2) — Prior art for the open issues

> Companion to [`2026-04-26-sync-design-1-api-surface-v2.md`](./2026-04-26-sync-design-1-api-surface-v2.md). v2 commits to **5 author-facing symbols**. The critique flagged 12 places where the 5-symbol surface is either incomplete or quietly hands a hard problem to an unspecified sub-design. This doc surveys how Convex, Replicache, Zero, Meteor, tRPC, GraphQL Subscriptions, Phoenix LiveView, Rails/Ecto, Temporal, and Postgres-native primitives solve each one — and recommends what v3 should adopt.
>
> Each section follows the same shape: **the issue**, **three to four prior-art mechanisms with the actual surface**, **the pattern that drops out**, **what to borrow for Singularity**.

---

## Issue 1 — Per-subscription lifecycle (start a watcher when somebody is reading)

`jsonl-viewer`, `terminal`, `logs`, and any future "watch this directory" resource need to spin up *some piece of work* on the 0→1 subscriber transition and tear it down on N→0. The v2 surface has no slot for it.

### 1.1 Meteor publications

Meteor's [`Meteor.publish`](https://docs.meteor.com/api/pubsub.html) is a function whose `this` *is* the subscription:

```js
Meteor.publish("rooms.events", function (roomId) {
  const handle = MyExternalSource.watch(roomId, (event) => {
    this.added("events", event._id, event);   // push to this subscriber
  });
  this.onStop(() => handle.stop());           // cleanup
  this.ready();
});
```

The lifecycle anchor is **the publication function call itself** — start work, register `onStop`. Each `Meteor.subscribe(...)` call from a client opens a fresh invocation; refcounting / pooling is the application's job. The publication can also `this.added/changed/removed` to push deltas, and Meteor's reactive `find()` cursors auto-do this when bound to a Mongo cursor.

### 1.2 GraphQL Subscriptions (`graphql-ws`, Apollo)

A subscription resolver returns an `AsyncIterable` ([graphql-ws spec](https://github.com/enisdenjo/graphql-ws/blob/master/PROTOCOL.md)):

```ts
const resolvers = {
  Subscription: {
    transcriptEvents: {
      subscribe: (_, { id }) => pubsub.asyncIterator(`fs:transcript:${id}`),
    },
  },
};
```

The iterable's `return()` method is the unsubscribe hook. The async iteration itself is the lifecycle: enter the `for await`, do setup; leave it (client disconnect, error), do cleanup. **Lifecycle = lexical scope of the iterator.** No separate `onFirstSubscribe` slot.

### 1.3 Phoenix Channels

```elixir
def join("transcript:" <> id, _params, socket) do
  {:ok, pid} = TranscriptWatcher.start_link(id, self())
  {:ok, assign(socket, watcher: pid)}
end

def terminate(_reason, socket) do
  TranscriptWatcher.stop(socket.assigns.watcher)
  :ok
end
```

`join/3` runs on connect, `terminate/2` on disconnect. Per-connection (not per-key) lifecycle, but the channel topic IS the key, so it works out the same. Phoenix multiplexes channels over one socket; each topic is its own GenServer process.

### 1.4 Convex's escape hatch — there is no per-subscription lifecycle

Convex queries are pure functions of `ctx.db`. To watch a non-DB source, Convex tells you to:

1. Run a **scheduled function** ([`convex/crons.ts`](https://docs.convex.dev/scheduling/cron-jobs)) or an **HTTP action** that polls/listens to the source.
2. Have it **`ctx.db.insert/patch`** rows into a regular table.
3. Queries read the table; reactivity flows from DB writes.

So Convex's answer is "**there's no such thing as a watcher tied to a query** — push state into a table and read it normally". Cost: the table is now a queue/log you maintain. Benefit: every reactive primitive collapses to "rows in tables".

### 1.5 Pattern + recommendation

Two viable shapes:

- **(A) Lifecycle-anchored query** — Meteor / Phoenix style. Add a paired `onActive` / `onIdle` (or `subscribe(ctx) → AsyncIterable`) slot to `query`. Surface grows to 6 symbols.
- **(B) Push into a table, read the table** — Convex style. Add a sibling primitive `defineSource({ name, run: (ctx) => …, refcount: "shared" | "per-input" })` whose body runs while ≥1 query is reading rows it produces. The query stays pure.

**Recommendation: (B), with a separate `defineSource`.** The five symbols stay clean; the new primitive only shows up in the ~5% of plugins that need it (jsonl, terminal, logs, fs-watch). Naming: `definePluginApi`, `query`, `mutation`, `source`, `useQuery`, `useMutation` — six symbols only when streaming is involved, five for the common case. (B) also forces a clean separation between *fetching* and *watching*, which today's `onFirstSubscribe` blurs.

---

## Issue 2 — Side-effecting mutations (DB write + filesystem + subprocess)

`conversations.create` does `tx.insert(_conversations)` **and** `setupWorktree()` **and** `forkDatabase()` **and** `runtime.create()` (tmux). v2's "1 mutation = 1 tx" rule turns three of those into orphans on rollback.

### 2.1 Convex — three verbs, hard wall between them

[Convex functions](https://docs.convex.dev/functions) split:

- **`query`** — pure read, cached, reactive; sandboxed (no `fetch`, no `setTimeout`, deterministic).
- **`mutation`** — atomic write; sandboxed; one OCC transaction; **no I/O**, no `fetch`.
- **`action`** — full Node runtime, can `fetch`, **no transaction**. May call `runQuery` / `runMutation` to interact with the DB.

Pattern: **mutations are pure-data; actions are everything else, with explicit hops back into mutations**.

```ts
export const launchAgent = action({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const agent = await ctx.runQuery(internal.agents.byId, args);
    const session = await spawnTmux(agent.prompt);   // side effect, no tx
    await ctx.runMutation(internal.agents.recordLaunch, { id: args.id, sessionId: session.id });
  },
});
```

Cost: authors must split. Benefit: the boundary is clear; "this code can be rolled back" vs "this code cannot" is reflected in the verb.

### 2.2 Rails — `after_commit` callbacks + ActiveJob outbox

Rails defaults to "do the side effect *after* the tx commits":

```ruby
class Conversation < ApplicationRecord
  after_commit :spawn_tmux, on: :create
  after_commit :enqueue_db_fork, on: :create
end
```

If the tx rolls back, callbacks don't fire. If the tx commits but the side effect fails, the side effect must be idempotent (or backed by a job queue with retries — the common pattern is `after_commit { SpawnTmuxJob.perform_later(self) }`). The "[transactional outbox](https://microservices.io/patterns/data/transactional-outbox.html)" pattern is this idea generalized: write a row into an `outbox` table inside the tx; a worker reads the outbox and does the side effect with at-least-once delivery.

### 2.3 Spring — `@TransactionalEventListener(phase = AFTER_COMMIT)`

Same idea, made declarative ([Spring docs](https://docs.spring.io/spring-framework/reference/data-access/transaction/event.html)):

```java
@Service
class ConversationService {
  @Transactional
  public Conversation create(...) { … return saved; }
}

@Component
class TmuxSpawner {
  @TransactionalEventListener(phase = AFTER_COMMIT)
  public void onConversationCreated(ConversationCreatedEvent e) { … }
}
```

The mutation publishes events; listeners run after commit. Decoupled, testable, but verbose.

### 2.4 Temporal — sagas with explicit compensation

For workflows where every step has a non-trivial inverse, [Temporal](https://docs.temporal.io/encyclopedia/application-design-patterns#saga) makes it explicit:

```ts
const handle = await temporal.start(workflow.createConversation, args);
// inside the workflow:
const task = await activities.createTask(args);
try {
  const worktree = await activities.setupWorktree(task.id);
  try {
    await activities.spawnTmux(worktree.path);
  } catch (e) { await activities.teardownWorktree(worktree.path); throw e; }
} catch (e) { await activities.deleteTask(task.id); throw e; }
```

Compensation per step. Heavyweight but honest.

### 2.5 Pattern + recommendation

Three approaches map to three trade-offs:

| Approach | Cost | Benefit |
|---|---|---|
| Three-verb (Convex) | author splits | every line of every function has a known reversibility |
| `after_commit` (Rails/Spring) | side effects must be idempotent | mutation handlers stay short; failure modes named |
| Saga (Temporal) | every step has an inverse | recovers from partial failure |

**Recommendation:** add a **third verb `action`** AND an **`afterCommit` hook on `mutation`**. Not redundant — they cover different cases:

- `action` for "the entire operation is non-DB or doesn't need a tx" (e.g. `agents.launch` orchestrating tmux without a write).
- `mutation`'s `ctx.afterCommit(fn)` for the common "write a row, then do one side effect" (e.g. `conversations.create` writes the row, then `afterCommit(() => runtime.create(...))`).
- For genuinely multi-step ops with reversal (worktree+fork+tmux), pair `mutation.afterCommit(() => job.enqueue(...))` with the existing `jobs` plugin — the saga lives there.

Surface count goes to **6 author symbols** (`definePluginApi`, `query`, `mutation`, `action`, `useQuery`, `useMutation`) — not 5, but the v2 doc was admitting that a future `action` was likely. Pin it now; don't bolt on later.

---

## Issue 3 — Internal-only declarations (callable from server, not from web)

`tasks-core` exports `createTask`, `findNextRankUnder`, `getAttempt` for plugin-to-plugin use. Today they're plain functions. In v2, if everything in `definePluginApi` is web-callable, internal helpers leak.

### 3.1 Convex — literal naming + generated `internal` namespace

Convex offers six function builders, paired by visibility:

```ts
import { query, mutation, action,
         internalQuery, internalMutation, internalAction } from "./_generated/server";

export const list = query({ … });               // callable from clients
export const _trim = internalMutation({ … });    // callable only from other server functions
```

The codegen produces two namespaces: `api.foo.list` (web) and `internal.foo._trim` (server-only). Same syntax, different bundle. The wire layer rejects `internal.*` calls from clients.

### 3.2 tRPC — middleware-gated procedures

```ts
const internalProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.isInternalCaller) throw new TRPCError({ code: "FORBIDDEN" });
  return next();
});
```

Same procedure shape; access control is a middleware. Less ergonomic than separate symbols (the rule is enforced at runtime, the type doesn't change).

### 3.3 PostgreSQL — schema-as-namespace

```sql
CREATE SCHEMA api;
CREATE SCHEMA internal;
GRANT USAGE ON SCHEMA api TO web_role;
REVOKE ALL ON SCHEMA internal FROM web_role;
```

PostgREST/Hasura expose `api.*`; `internal.*` is invisible to HTTP clients but callable from triggers, functions, and other internal code. **Visibility is a deployment concern, not a code concern.**

### 3.4 Pattern + recommendation

Convex's split is the cleanest: same shape, different name, the type system tells you which namespace you're in. Direct adoption:

```ts
export const tasksCoreApi = definePluginApi("tasks-core", {
  listTasks: query({ … }),                    // public
  createTask: mutation({ … }),                // public
  findNextRankUnder: internalQuery({ … }),    // server-only, no wire route
  backfillMetaParent: internalMutation({ … }),// server-only
});
```

Two new symbols (`internalQuery`, `internalMutation`). The wire layer skips internal-prefixed entries; `call()` resolves both. `./equin check` rejects `useQuery(api.foo.findNextRankUnder)` at compile time because `internalQuery` returns a different branded type than `query`.

This also clarifies the tx-sharing question (issue 4): internal mutations called via `call` join the parent tx; public mutations called from the web open a fresh tx.

---

## Issue 4 — Cross-plugin `call` and tx sharing

When `agents.launch` calls `conversations.create` calls `tasks-core.createTask`, whose tx is in scope?

### 4.1 Convex — single tx, `runMutation` joins it

Inside a Convex `mutation`, `ctx.runMutation(internal.foo.bar, args)` runs **in the same OCC transaction**. The whole call tree commits or aborts together. There is no nesting/savepoint primitive; the tx is flat. ([Convex transaction model](https://docs.convex.dev/database/advanced/occ).)

This works because Convex mutations are short, deterministic, and limited to the local DB. Long-running orchestration must use `action`.

### 4.2 Postgres — savepoints (`BEGIN; SAVEPOINT a; … ROLLBACK TO a; …`)

PL/pgSQL functions called from within a tx implicitly inherit it; the engine lets you create savepoints (sub-transactions) for partial rollback. SQL Server and Oracle have similar models.

### 4.3 Spring `@Transactional(propagation = …)`

Spring exposes seven propagation modes:

- `REQUIRED` (default) — join existing or start new
- `REQUIRES_NEW` — suspend caller, start fresh tx
- `NESTED` — savepoint within caller
- `MANDATORY` — must already be in tx, else error
- `NEVER` — must NOT be in tx, else error

The combinatorics are awful; teams pick a default and forbid the rest. But it shows the design space the v2 doc hand-waves over.

### 4.4 Replicache / Zero — same mutator runs locally and on server

Mutators are pure-data and are designed to be called only at the top level (client triggers, server replays). Cross-mutator composition is "function call within the same tx" — same as Convex. They sidestep nested-tx semantics by forbidding actions/I/O in mutators.

### 4.5 Pattern + recommendation

The honest answers in the wild are: (a) flat tx joined by all callees (Convex), (b) savepoint-per-call (Postgres native), (c) configurable propagation (Spring — nobody likes it).

**Recommendation: flat tx by default, savepoint on opt-in.**

```ts
handler: async ({ tx, call }) => {
  await call(tasksCoreApi.createTask, args);     // joins tx
  await call.savepoint(otherApi.risky, args);    // savepoint; rollback isolated
}
```

`call.savepoint` is the only nested-tx primitive, and it's used rarely. Combine with the `internal*` rule from issue 3: only `internal*` mutations can be called via `call`; public mutations always open a fresh tx (because they may be entered from web with no parent tx in scope). This makes the rule **a function of declaration site, not call site** — the kind of property `./equin check` can enforce statically.

---

## Issue 5 — Background work has no place in the surface

`poller`, `turn-emitter`, scheduled crons. These are neither queries nor mutations.

### 5.1 Convex — `crons.ts` declares schedules

```ts
// convex/crons.ts
import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();
crons.interval("reconcile runtimes", { seconds: 1 }, internal.conversations.reconcile);
crons.cron("daily backup", "0 3 * * *", internal.backups.daily);
export default crons;
```

The cron file is a sibling to `query.ts` / `mutation.ts`. The body of each scheduled job is an `internalMutation` or `internalAction`. **Background work = scheduled call into the API surface**, not a separate mechanism.

### 5.2 Inngest / Trigger.dev — function-typed jobs with triggers

```ts
inngest.createFunction(
  { id: "reconcile-runtimes" },
  { cron: "*/1 * * * *" },
  async ({ step }) => { await step.run("tick", reconcileRuntimes); },
);
```

Same idea — declarative trigger (cron or event) → function body. Step-level durability (the body can resume mid-flight after a deploy).

### 5.3 Phoenix — supervised GenServer + `:timer.send_interval`

```elixir
defmodule Conversations.Poller do
  use GenServer
  def init(_), do: { :ok, schedule_tick() }
  def handle_info(:tick, state) do
    reconcile()
    schedule_tick()
    { :noreply, state }
  end
  defp schedule_tick(), do: Process.send_after(self(), :tick, 1000)
end
```

Native to the runtime. Singularity's Bun process plays the same role.

### 5.4 Pattern + recommendation

Convex's pattern is a tight fit because it composes with the rest of the surface: a cron is just an `internalMutation` with a schedule attached.

**Recommendation: add `schedules` to `definePluginApi`** (not a new top-level symbol):

```ts
export const conversationsApi = definePluginApi("conversations", {
  reconcile: internalMutation({ handler: async ({ call }) => { … } }),
  schedules: {
    "every 1s": { fn: "reconcile" },
    "daily 03:00": { fn: "rollupStats" },
  },
});
```

The `schedules` block is metadata, not a verb — author symbol count unchanged. The runtime translates each entry into a `setInterval` / cron tick that calls the named function. **Mark this as the only legitimate way to do background work**; ban `setInterval` outside `definePluginApi.schedules` via `./equin check`.

The existing `jobs` plugin handles long-running / multi-step work; cron is *not* the same primitive. Cron triggers; a `defineJob` body steps. The two compose: a cron's body can `await job.enqueue(...)`.

---

## Issue 6 — Read-set tracking cliffs

If an author writes `db.execute(sql\`...\`)` for perf, read-set tracking silently breaks. The UI goes stale. Today's `dependsOn` would be visibly missing; tomorrow's "automatic" tracking is invisibly missing.

### 6.1 Convex — query API is the only thing the engine sees

Convex's `ctx.db` is **not Postgres**. It's Convex's own document store, with a closed query API (`q.eq`, `q.gt`, `withIndex`, `paginate`, etc.). There is no "raw SQL escape hatch" because there's no SQL. **Read-set tracking is total because the API surface is total.** Cost: you can't use the rest of the SQL ecosystem.

### 6.2 Materialize / RisingWave — parsed SQL, IVM-maintained

[Materialize](https://materialize.com/docs/) accepts standard SQL (`CREATE MATERIALIZED VIEW ...`), parses it, and maintains the result via [differential dataflow](https://timelydataflow.github.io/differential-dataflow/). The author writes SQL; the engine knows the read set because it parsed the query plan. Raw side-channel reads are simply not available — there's no `db.execute(arbitrary_string)` that bypasses the planner.

### 6.3 ElectricSQL — explicit "shapes"

[ElectricSQL shapes](https://electric-sql.com/docs/guides/shapes) are server-side declarations: "this client wants rows from `issues` where `team_id = X`". The shape is the read-set; the client can't escape it. Reads on the client are then arbitrary SQL against the local SQLite, but those reads are **not** what the server tracks — the server tracks the *shape*.

### 6.4 LiveStore / Riffle / RxDB

LiveStore and Riffle let you write SQL on top of an embedded SQLite, intercept the parse tree, and derive read-set per query. Works because the SQL is parsed before execution. Same constraint: the engine must see the parse tree; no untyped escape hatch.

### 6.5 Pattern + recommendation

Three families of solutions:

- **Closed API (Convex)** — no escape hatch; tracking is total because the surface is total.
- **Parsed SQL (Materialize, ElectricSQL, LiveStore)** — author writes SQL strings, but they go through a parser that records the read set.
- **Tracked Drizzle (proposed v2)** — instrument Drizzle's builder; raw SQL bypasses tracking.

The proposed v2 surface inherits Drizzle's escape hatches (`db.execute(sql\`...\`)`, `sql\`raw\``). Tracking is partial unless we close the door.

**Recommendation:** explicitly state in v2 that `ctx.db` is **a constrained subset of Drizzle** that prohibits raw SQL. Add `./equin check --no-raw-sql-in-handlers` to enforce it. The escape hatch is `internalQuery` with a manual `invalidatesOn` — same way non-DB sources work. Make the constraint visible at lint time, not invisible at runtime.

This is also the place to acknowledge the granularity question (table vs row vs predicate): publish a "tracking guarantee table" listing which Drizzle operators yield row-level vs table-level invalidation, so authors can predict cost.

---

## Issue 7 — Non-JSON wire (uploads, binary, custom Response)

Attachments upload, attachment download, image preview. v2 implicitly assumes JSON-in/JSON-out.

### 7.1 Convex — `httpAction` is the escape hatch

```ts
export const upload = httpAction(async (ctx, request) => {
  const blob = await request.blob();
  const storageId = await ctx.storage.store(blob);
  await ctx.runMutation(internal.attachments.record, { storageId });
  return new Response(JSON.stringify({ id: storageId }));
});
```

[`httpAction`](https://docs.convex.dev/functions/http-actions) gets a real `Request`, returns a real `Response`. Routed via a separate `convex/http.ts` file with an Express-style router. Outside the query/mutation system entirely.

### 7.2 Convex storage — signed upload URLs

For large uploads, Convex prefers ([docs.convex.dev/file-storage](https://docs.convex.dev/file-storage)):

```ts
export const generateUploadUrl = mutation({
  handler: async (ctx) => ctx.storage.generateUploadUrl(),
});
```

Client `PUT`s directly to the signed URL; server records the resulting `storageId` via a follow-up mutation. **Two round trips, but the upload bypasses the function runtime.**

### 7.3 React Server Actions — `FormData` is first-class

```tsx
async function uploadAvatar(formData: FormData) {
  "use server";
  const file = formData.get("file") as File;
  await fs.writeFile(...);
}
```

`<form action={uploadAvatar}>` posts FormData; the action receives it natively. No separate "upload route" — uploads are mutations whose input is `FormData` rather than JSON.

### 7.4 Pattern + recommendation

Three options:

- **(A) `httpAction` escape hatch** (Convex) — keep `mutation` JSON-only; route binary through a separate verb.
- **(B) `mutation` accepts `FormData` / returns `Response`** (Server Actions) — polymorphic input/output type.
- **(C) Signed upload URLs** (Convex storage) — uploads bypass the function runtime entirely.

**Recommendation: keep today's `httpRoutes` for binary/custom-response endpoints; rename it to `defineHttpEndpoint` to mark it as a deliberate escape hatch.** The `attachments` plugin already needs this; pretending otherwise is dishonest. Surface count: 6 author symbols + the rare `defineHttpEndpoint` for binary I/O.

Make the `mcp` plugin's HTTP endpoint, screenshot upload, attachment serve, code-explorer image serve all use this escape hatch. **Mark it as "use only when the wire is genuinely not JSON"** so it doesn't become the default.

For client uploads at scale, copy Convex storage: a `generateUploadUrl` mutation + direct PUT. Today's `attachments` plugin POSTs through the server; future scale would benefit, but it's not blocking.

---

## Issue 8 — `call` ambient resolution vs codegen

`call(conversationsApi.create, …)` resolves via runtime registry. A missing plugin is a runtime error.

### 8.1 Convex — codegen module that's a real import

`./_generated/api.ts` is generated by `npx convex dev` and committed (or gitignored, then regen'd at build). The author writes `import { api, internal } from "../_generated/api"` and gets real values whose types track the actual function definitions. **Renaming a function is a compile error in every call site**, because the call site imports the symbol.

This is what the v2 doc parenthesises as "codegen alternative" in §3.3. In Convex it's the *only* path; the three-line shared file isn't an option.

### 8.2 tRPC — `typeof appRouter`

```ts
export type AppRouter = typeof appRouter;
const trpc = createTRPCClient<AppRouter>({ … });
```

No codegen — the type bridge is the type system. Same idea as v2's `shared/api.ts`. Works for a flat router; gets awkward when each plugin owns a sub-router and the root just merges them. tRPC's [router merging](https://trpc.io/docs/server/merging-routers) is a runtime composition; the type follows.

### 8.3 Hono / Eden — `typeof app`

```ts
const route = app.post('/posts', zValidator('json', schema), c => c.json({…}));
export type AppType = typeof route;
const client = hc<AppType>('http://...');
```

Same pattern as tRPC; the difference is the route map is HTTP-shaped rather than RPC-shaped.

### 8.4 Pattern + recommendation

Codegen vs `typeof` is a classic trade-off:

- **Codegen** — committed artifact, no compile-time type chain, breaks if rebuild forgotten.
- **`typeof`** — implicit dependency on TS reading the server tree from the shared file's type-only import.

The `typeof` approach works fine for tRPC because there's one root router. v2's "one shared file per plugin" is the same thing per-plugin, which is fine — but it doesn't address the original concern (a missing plugin at runtime).

**Recommendation:** keep the type bridge as `typeof` (per-plugin shared file is fine), AND add a `./equin check --plugin-call-targets-exist` rule that statically verifies every `call(x, …)` target's plugin is in the registry's `web/src/plugins.ts` and `server/src/plugins.ts`. Plus emit a runtime error early at boot if a registered `call` target is missing — fail fast, not at first request.

The third option — Convex-style real codegen with `convex dev` — is more powerful but more machinery. Defer.

---

## Issue 9 — Cross-process / cross-worktree fan-out

`auth.fanoutInvalidate` POSTs to every worktree. v2's `Sync.emit` is process-local.

### 9.1 Postgres LISTEN/NOTIFY — built into the DB

```sql
NOTIFY auth_invalidated, '{"reason":"token-rotated"}';
LISTEN auth_invalidated;  -- driver fires async event
```

Every Postgres connection that's listening receives the message. **The DB is the broker.** Pros: zero infra, ordering guarantees with the writing tx, simple. Cons: payload size limit (~8KB), no persistence (offline listeners miss messages), polling fallback under heavy load.

### 9.2 Convex — single backend; cross-process is invisible to the author

Convex's serverless backend handles fan-out. Authors don't see processes. Same in any single-broker SaaS (Firebase, Supabase Realtime).

### 9.3 Redis pub/sub or NATS

Standard infra add. ([Phoenix.PubSub](https://hexdocs.pm/phoenix_pubsub/), [GraphQL subscriptions over Redis](https://github.com/davidyaha/graphql-redis-subscriptions)) — drop-in broker between processes.

### 9.4 Replicache / Zero — server pull endpoint is the broker

Both rely on a single canonical server. Multi-process scaling is the canonical-server's problem (DB read replicas + sticky sessions, or the canonical server is itself stateless and reads from a shared DB).

### 9.5 Pattern + recommendation

Singularity already runs Postgres per worktree, with `__singularity_migrations` etc. Postgres LISTEN/NOTIFY is the cheapest fan-out:

```ts
// inside Sync.emit
async function emit(tag: string) {
  await db.execute(sql`SELECT pg_notify('singularity_sync', ${tag})`);
}

// at startup, every server process:
const listenConn = await pool.connect();
await listenConn.query("LISTEN singularity_sync");
listenConn.on("notification", (msg) => localFanout(msg.payload));
```

**Recommendation:** make `Sync.emit` write to Postgres LISTEN/NOTIFY by default. Cross-worktree fan-out becomes free. The auth fanout HTTP-as-IPC pattern goes away.

For the few cases where a tag *should* stay process-local (high-frequency internal-only invalidation), add `Sync.emit(tag, { local: true })` — but the default is broadcast.

---

## Issue 10 — Optimistic updates, beyond the sketch

v2's optimistic API is:

```ts
useMutation(api.create).optimistic((cache, input) => cache.update(api.list, …, fn));
```

Three holes flagged: temp-id rebinding, cross-plugin coherence, rollback semantics.

### 10.1 Convex — `withOptimisticUpdate(localStore, args)`

```ts
const send = useMutation(api.messages.send).withOptimisticUpdate((store, args) => {
  const cur = store.getQuery(api.messages.list, { channel: args.channel }) ?? [];
  store.setQuery(api.messages.list, { channel: args.channel },
    [...cur, { _id: "tmp", ...args }]);
});
```

Single shared `localStore` keyed by `(query, args)`. When the authoritative response arrives via WS, **Convex re-runs all queries against the new server state** — the optimistic patch is overwritten by truth. ID rebinding is implicit because the new authoritative row has a different `_id` and the patch is gone.

For drag-and-drop / animations that care about identity stability, Convex offers no special help; authors use stable client-generated IDs ("client-issued IDs") inserted into the optimistic state, then reconcile.

### 10.2 Replicache / Zero — speculative tx that replays

Mutators run **twice**: once locally on speculation, once on the server canonically. The local KV store applies the speculative result; subscriptions re-fire. When the server's pull lands with the canonical state, Replicache rolls back the speculative tx and replays in canonical order. **Identity is preserved because mutators put rows at known keys** — the speculative `tx.set("/todo/abc", {...})` is at the same key as the canonical version, so React's `key={id}` is stable.

This is the strongest model for animations / drag-and-drop. Cost: mutators must be pure data-writes (no fetch, no actions); else replay diverges.

### 10.3 TanStack Query — `onMutate` returns rollback context

```ts
useMutation({
  mutationFn: createTodo,
  onMutate: async (newTodo) => {
    await queryClient.cancelQueries(["todos"]);
    const prev = queryClient.getQueryData(["todos"]);
    queryClient.setQueryData(["todos"], (old) => [...old, newTodo]);
    return { prev };
  },
  onError: (err, newTodo, ctx) => queryClient.setQueryData(["todos"], ctx.prev),
});
```

Manual but explicit. The "rollback context" idea is worth borrowing — it makes the rollback path inspectable.

### 10.4 Apollo Client — `optimisticResponse` with normalized cache

Apollo normalizes by `__typename` + `id`. Optimistic responses are merged into the normalized cache; the eventual real response replaces them by `id`. **Cross-query coherence is automatic** because every query reads from the same normalized graph.

### 10.5 Pattern + recommendation

Three quality tiers:

- **Tier 1 (TanStack)**: per-mutation rollback, no cross-query coherence.
- **Tier 2 (Convex)**: per-query localStore, cross-query coherence via re-running, identity unstable across rebind.
- **Tier 3 (Replicache/Zero)**: speculative tx, identity stable, mutators must be pure data.

**Recommendation: target Tier 2 (Convex)**, because Singularity's mutations are *not* pure data (they call tmux, fork DBs). Tier 3 needs that purity. Tier 2 fits.

Spec the localStore as:

```ts
useMutation(api.create).optimistic((store, input) => {
  // store.getQuery / store.setQuery / store.patchQuery
  // store.tempId() returns a stable client-generated ID, rebound on commit
  const tempId = store.tempId();
  store.patchQuery(api.list, { parentId: input.parentId }, rows =>
    [...rows, { id: tempId, ...input, _optimistic: true }]);
});
```

The `tempId()` API is the rebinding primitive — when the server confirms with a real ID, `store` rewrites every reference from `tempId` to the real ID before the next render. This gets you 80% of Replicache's identity-stability without requiring pure mutators.

---

## Issue 11 — Request context (identity, source, headers)

`createConversation` needs `spawnedBy`. v2 has no `ctx.identity`.

### 11.1 Convex — `ctx.auth.getUserIdentity()`

```ts
export const create = mutation({
  args: { … },
  handler: async (ctx, args) => {
    const user = await ctx.auth.getUserIdentity();
    if (!user) throw new ConvexError("unauthenticated");
    await ctx.db.insert("conversations", { ...args, ownerId: user.subject });
  },
});
```

`ctx.auth` is populated by the framework from a JWT in the request. Per-call. ([Convex auth](https://docs.convex.dev/auth).)

### 11.2 tRPC — middleware-set `ctx`

```ts
const isAuthed = t.middleware(({ ctx, next }) => {
  if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED" });
  return next({ ctx: { user: ctx.user } });   // refines ctx type
});
const protectedProcedure = t.procedure.use(isAuthed);
```

Middleware narrows `ctx.user` from `User | null` to `User`. The handler receives a typed identity slot.

### 11.3 Zero — `ctx.userID` typed slot

```ts
const updateIssue = defineMutator(
  schema,
  async ({ tx, ctx: { userID }, args }) => { … },
);
```

`ctx` is a typed object with whatever the schema declared. Auth lives there.

### 11.4 RSC — `headers()` / `cookies()` from the request

```ts
"use server";
import { headers } from "next/headers";
async function action() { const h = await headers(); … }
```

Per-call request context, accessed lazily. The handler doesn't take it as an argument; it pulls from a request-scoped `AsyncLocalStorage`.

### 11.5 Pattern + recommendation

All four expose request context, differing only in plumbing. **Reserve the slot now in v2**:

```ts
type QueryCtx = {
  input: Input;
  db: TrackedDb;
  call: TypedCall;
  identity: Identity;       // reserved; sub-design 6 specs the shape
  signal: AbortSignal;
};
```

`Identity` starts as `{ kind: "local-user" }` (single-user assumption). Plugins that don't need it ignore the field. When multi-tenant arrives, the field grows; existing handlers don't break. **Adding the field after the fact is a breaking change to every handler**; reserving is free.

For Singularity-specific context (the originating worktree, `spawnedBy`, etc.), pack it into `identity` at the same time — there's no reason to have two ctx slots.

---

## Issue 12 — Streams as first-class vs out-of-band

Terminal output, log tail, jsonl event firehose. v2 punts to existing `wsRoutes`.

### 12.1 GraphQL Subscriptions — third verb, `AsyncIterable` return

```graphql
type Subscription { logEvent: LogEvent! }
```

```ts
const resolvers = {
  Subscription: {
    logEvent: { subscribe: () => pubsub.asyncIterator("log_event") },
  },
};
```

[graphql-ws](https://github.com/enisdenjo/graphql-ws) pipes the iterator over WebSocket. Type system unified with `Query` / `Mutation`; same schema, same auth, same client cache (sort of).

### 12.2 Convex — no streams, push into a table

Same answer as issue 1. Logs become rows; the query reads the latest 100; the engine reactively delivers updates. **Works for low-rate streams**; falls over for terminal output (10kHz writes are not table inserts).

### 12.3 Phoenix Channels — orthogonal primitive

Phoenix's `LiveView` is for reactive state; `Channels` is for streams; they're different abstractions, deliberately. The framework doesn't pretend they unify.

### 12.4 tRPC — `subscription` builder + `observable`

```ts
appRouter.subscription("logEvents", {
  resolve: ({ ctx }) => observable<LogEvent>((emit) => {
    const off = onLog((e) => emit.next(e));
    return () => off();
  }),
});
```

Third verb on the same router. Wire is split (HTTP for query/mutation, WS for subscription) but the author doesn't see it.

### 12.5 Pattern + recommendation

Two honest options:

- **(A) Add a third verb `subscription({ source })`** — GraphQL/tRPC style. Authors get one consistent surface. Cost: surface count grows.
- **(B) Keep `wsRoutes` as a deliberate escape hatch** — admit streams aren't part of the reactive cache, route them separately.

The v2 doc's recommendation in §8 question 2 is (B). I agree — terminal at 10kHz, log tails, multi-MB transcript replay are not the same shape as "row in a table changed". Forcing them through `query` would either degrade query performance or distort the streaming case.

**Recommendation: codify (B).** Rename `wsRoutes` to `defineStream` in `definePluginApi`:

```ts
export const terminalApi = definePluginApi("terminal", {
  pty: defineStream({
    input: z.object({ id: z.string() }),
    handler: async function* ({ input, signal }) {
      const pty = await openPty(input.id);
      try { for await (const chunk of pty.stdout) yield chunk; }
      finally { pty.close(); }
    },
  }),
});

// client
const stream = useStream(terminalApi.pty, { id });
for await (const chunk of stream) terminalRef.current?.write(chunk);
```

Surface count: 7 (`definePluginApi`, `query`, `mutation`, `action`, `defineStream`, `useQuery`, `useMutation`, `useStream`). Higher than the v2 promise of 5, but it covers the actual surface area honestly. The v2 "5 symbols" claim is achievable only by amputating valid use cases; better to admit the count and structure them coherently.

---

## Summary of recommended v3 deltas

| Issue | v2 says | v3 should say |
|---|---|---|
| 1. Lifecycle hooks | (silent) | Add sibling `defineSource({ run, refcount })`; query stays pure |
| 2. Side-effecting mutations | "1 mutation = 1 tx" | Add `action` verb + `ctx.afterCommit(fn)` |
| 3. Internal-only | (silent) | Add `internalQuery` / `internalMutation`; only those joinable via `call` |
| 4. Cross-plugin tx | "shared by default" | Flat tx by default; `call.savepoint(...)` for opt-in nesting |
| 5. Background work | (silent) | `schedules: {…}` block in `definePluginApi`, calls into `internal*` |
| 6. Read-set cliffs | "engine's call" | Constrain `ctx.db` to no-raw-SQL; lint-enforce; publish granularity table |
| 7. Non-JSON wire | (silent) | Keep `defineHttpEndpoint` as deliberate escape hatch |
| 8. `call` resolution | runtime registry | `typeof` bridge + lint check for call targets |
| 9. Cross-process fan-out | (silent) | `Sync.emit` writes Postgres LISTEN/NOTIFY by default |
| 10. Optimistic | one-line bullet | Spec `localStore` API with `tempId()` rebinding (Convex Tier 2) |
| 11. Request context | "sub-design 6" | Reserve `ctx.identity` slot now; ship as `{ kind: "local-user" }` |
| 12. Streams | "leave as-is" | Rename `wsRoutes` to `defineStream`; surface 7 honest symbols |

The v2 promise of "5 symbols" was always going to lose; the question is whether it loses gracefully (adding 2-3 verbs that map to real categories of work) or chaotically (each open question turns into a separate ad-hoc primitive). Convex's eight-verb surface (`query`, `mutation`, `action`, `internalQuery`, `internalMutation`, `internalAction`, `httpAction`, `cron`) is a useful upper bound on where this lands honestly.

Pinning these now — before sub-designs 2–5 commit code — is cheap. Letting them surface piecemeal during implementation is what produced today's five-surface mess.
