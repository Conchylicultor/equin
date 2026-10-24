# Sync sub-design 2: the reactivity engine

> Scope: how queries discover what they read, how the engine knows when to re-run them, and how it computes a minimal answer. Targets issues **#1 (manual fragile reactivity), #2 (hand-drawn `dependsOn` graph), #3 (full-payload granularity), #13 (per-resource loader cost), #14 (no query-time params beyond hardcoded loader)** from `research/2026-04-26-sync-engine-issues.md`. Wire format, mutation API, and developer DX live in sibling sub-designs.

## 1. Problem restatement

Today every server-side resource is `loader: async () => db.select()...`, an opaque thunk. Mutations call `resource.notify()` by hand, and resources cross-subscribe via a hand-asserted `dependsOn: [otherResource]` array. The engine has no idea what tables/rows a loader actually reads, so two things go wrong: (a) a write to a table the author forgot about silently leaves UI stale, and (b) every notify re-runs the entire loader and re-broadcasts the entire payload, even if one row in a thousand-row list changed. The single primitive `(key, params) → JSON` collapses three orthogonal concerns — *what* depends on *what*, *how* fine the change tracking is, and *which* parameter slice each subscriber wants — into one coarse hand-managed knob. The reactivity engine is the load-bearing piece of the redesign: every other sub-design (wire format, optimistic mutations, plugin DX, debug UI) inherits its dependency-tracking and granularity choices.

## 2. Two main families

Frameworks that solve the "react to DB change" problem split cleanly along one axis: **does the engine know the structure of every query, or does it only see opaque function calls?**

**(a) Explicit / declarative tracking.** Queries are expressed in a restricted query language the engine can analyse — a relational AST (ZQL, ZQL-over-SQLite in Zero), a shape definition (ElectricSQL, PowerSync buckets), a CRDT-typed pattern (Triplit), or a streaming dataflow (Materialize, Materialite). Because the engine has the full AST, it can (1) statically derive the read set without running the query, (2) compile the query to a *dataflow graph* that consumes per-row deltas and emits per-row deltas — the textbook *Incremental View Maintenance* recipe — and (3) share sub-pipelines between queries that overlap. The cost: query language is a strict subset of what hand-written code can express. Joins limited to equi-joins, no arbitrary JS in the middle of a query, fixed operator set.

**(b) Implicit / runtime tracking.** Queries are arbitrary code (a JS function, a Convex `handler`, a SolidJS `createMemo` body, a MobX getter). The engine wraps the data the function reads with a tracking proxy or instrumented accessor; whatever the function touches becomes a *read set* recorded for that run. On the write side, mutations are likewise wrapped: each write contributes to a *change log*. After a write, the engine intersects the change log against every subscription's read set; matches schedule a full re-run. Convex, MobX, SolidJS, Vue's `reactive`, and Angular signals all do this in different flavours (function-call tracking, ES Proxies, getter/setter shims, signal call sites). The cost: re-runs are full re-runs. There is no IVM — just smart "should this re-run?" detection. You get correctness for free; you do not get incremental computation for free.

The fundamental tradeoff: **declarative limits expressiveness but unlocks IVM and shared materialization; imperative is maximally flexible but pays full re-execution cost on every miss**. A real-world system usually picks one and adds escape hatches for the other.

## 3. Frameworks surveyed

### 3.1 Convex (implicit tracking, full re-run, range-level read sets)

Convex query functions are arbitrary JS that read via `ctx.db.get(id)` or `ctx.db.query("table").withIndex(...).filter(...).collect()`. The runtime instruments `ctx.db`: every `get` records the document id; every indexed scan records the **index range predicate** (not the individual rows visited) ([How Convex Works](https://stack.convex.dev/how-convex-works), [Reading Data | Convex Docs](https://docs.convex.dev/database/reading-data/)).

```ts
export const openTasks = query({
  args: { listId: v.id("lists") },
  handler: async (ctx, { listId }) =>
    await ctx.db
      .query("tasks")
      .withIndex("by_list_status", q => q.eq("listId", listId).eq("status", "open"))
      .collect(),
});
```

The read set here is "index `by_list_status`, range `(listId, 'open')`". After the query runs, the sync worker stores `{ readSet, beginTimestamp, args }` against that subscription. Mutations commit with a write set; a single OCC algorithm both detects mutation conflicts and detects subscription invalidation by walking the commit log after `beginTimestamp` and looking for any write whose row falls inside any subscriber's range predicate ([Convex Docs - Best Practices](https://docs.convex.dev/understanding/best-practices)).

- **Granularity:** index-range. Coarser than per-row, vastly finer than table-level. A write that matches the predicate triggers re-run; one that doesn't, doesn't.
- **Joins:** the function does them imperatively (multiple `ctx.db.get`/`query` calls in sequence). Each contributes a separate range to the read set; correctness composes.
- **Cost:** every invalidation re-runs the entire query function from scratch. No IVM. The bet is that with the right indexes, a re-run is millisecond-cheap.
- **Params:** params are just function arguments. Each `(query, args)` tuple is a separate cache entry (separate read set). Subscribers with the same args share one entry.

### 3.2 Zero / Materialite (explicit tracking, true IVM, per-row deltas)

Zero is the full product; Materialite is the IVM kernel ([rocicorp/mono](https://github.com/rocicorp/mono), [vlcn-io/materialite](https://github.com/vlcn-io/materialite)). Queries are ZQL — a relational DSL with `where`, `related`, `orderBy`, `limit`, `start` — and the server has the *entire AST*. The view-syncer compiles the AST into a dataflow graph of operators (filter, join, reduce, count, union) over multisets, then runs **"hydrate once, then push diffs"**: the first execution materializes the result; subsequent Postgres logical-replication events flow through the graph as `+row`/`−row` deltas, and only the operators that actually see a delta do work ([Zero docs](https://zero.rocicorp.dev/docs/queries), [Marmelab on Zero](https://marmelab.com/blog/2025/02/28/zero-sync-engine.html)).

```ts
const issues = z.query.issue
  .where("status", "open")
  .related("comments", c => c.orderBy("createdAt", "desc").limit(5))
  .orderBy("createdAt", "desc");
```

Materialite's walkthrough makes the operator chaining explicit ([Materialite walkthrough](https://github.com/vlcn-io/materialite/blob/main/demos/react/walkthrough/walkthrough.md)):

```ts
db.tasks.stream.filter(t => t.priority === "high").materialize(taskComparator);
```

- **Granularity:** per-row delta (`+row` / `−row` in a multiset). Wire payload is the diff.
- **Joins:** first-class — multi-stream joins maintain hash-indexed state per side; an upstream delta produces only the matching downstream deltas. (Materialite's notes flag join state as the most expensive thing to maintain — every join doubles memory pressure ([Materialite notes.md](https://github.com/vlcn-io/materialite/blob/main/notes.md)).)
- **Cost:** O(delta), not O(result). Pagination/`limit` is built into the operator set, not bolted on.
- **Params:** ZQL queries are parametrised; each parameter tuple is a separate compiled pipeline. Common sub-pipelines (e.g. the `filter status=open` upstream of two paginated views) can be shared — Materialite calls these "branched" streams. Zero also runs the same ZQL query both client-side (against IndexedDB) and server-side (against the replica), so the client gets instant local results before the network resolves.

### 3.3 ElectricSQL (explicit, per-row CDC, single-table shapes)

Shapes are the unit of subscription: `(table, where, columns)` ([ElectricSQL Shapes guide](https://electric-sql.com/docs/guides/shapes)). The server reads Postgres's logical replication slot, maps each row change to the shapes it matches, and emits an HTTP-streamed *Shape Log* of inserts/updates/deletes. The client materializes the log into a local row collection.

```ts
new ShapeStream({
  url: "/v1/shape",
  params: { table: "todos", where: "status IN ('backlog','todo')", columns: "id,title,status" },
});
```

- **Granularity:** per-row CDC events.
- **Joins:** **none**. Shapes are single-table by design ("you can use subqueries to filter, but the shape contains rows of one table"). Multi-table queries = multiple shapes joined in the client.
- **Cost:** server pays a per-shape `where`-evaluation cost on every WAL event (the docs warn that non-optimised `where`s degrade throughput inversely with shape count).
- **Params:** baked into shape definition; immutable once subscribed. Different param tuples = different shapes.

### 3.4 Triplit (explicit, IVM, CRDT-typed)

Triplit ([Triplit 1.0 blog](https://www.triplit.dev/blog/triplit-1.0)) is closest to "ElectricSQL with relational queries". A custom relational query language sits on top of a CRDT data model; both server and client run an IVM engine, so a write produces granular diffs to subscribers rather than re-broadcasting full result sets. The blog explicitly frames the win as: *"Under the hood, Triplit implements incremental view maintenance to update queries as new changes occur to the database… on the server, this system calculates granular diffs to send to the client, rather than repeatedly sending the entire result set."*

- **Granularity:** per-row diffs.
- **Joins:** supported via relational subqueries ("relational queries can get complex pretty quickly, so Triplit applies many of the same tricks and optimizations that popular SQL databases use").
- **Cost:** IVM, but joins are still the expensive case (see DBSP / "Hard Things About Sync" ([Joy Gao](https://expertofobsolescence.substack.com/p/the-hard-things-about-sync)) — IVM-on-arbitrary-joins is *the* unsolved problem in the space).
- **Params:** queries are values, not strings; each unique query AST is a subscription.

### 3.5 LiveStore (implicit-on-SQLite + event sourcing)

LiveStore ([livestore docs](https://docs.livestore.dev/evaluation/how-livestore-works/)) puts a SQLite database on the client and treats it as the materialised projection of an immutable event log. The reactivity layer is **signals over SQL queries**: a React hook re-runs a SQL query when the SQLite tables it reads change. Tracking is implicit (the engine watches commit hooks on the affected tables) but at table-level granularity, not row-level. Cross-client sync is push/pull on the event log, not on rows.

- **Granularity:** table-level invalidation, full SQL re-run.
- **Joins:** whatever SQLite supports — but they re-execute on every notify.
- **Cost:** full re-run on each invalidation; SQLite is fast enough that this is usually fine.
- **Params:** parametrized SQL; one cache entry per parameter tuple.

### 3.6 Linear's sync engine (implicit, model-graph based, OT-style)

Linear's engine ([reverse-engineering writeup](https://github.com/wzhudev/reverse-linear-sync-engine), [Tuomas Artman blog](https://linear.app/now/scaling-the-linear-sync-engine)) is *not* a relational query engine at all. The unit is a **model** (Issue, Team, Comment) defined with TypeScript decorators; instances live in an in-memory Object Pool keyed by UUID. MobX wraps each property to make reads tracked and writes observable. Server transactions broadcast **delta packets** (per-property change descriptors `{ id, action: I|U|D|A|V|C|G|S, modelName, modelId, data }`) that clients apply to their pool; the local MobX graph then re-renders only the components that read those specific properties.

The "what to subscribe to" question is answered by **sync groups** (workspace, team, user) selected at bootstrap time, not by per-query subscription. The "what's stale" question is answered by `lastSyncId`, a monotonic global version; reconnects re-fetch deltas since the last seen id. Lazy loading uses **partial indexes** (e.g. `comments.issueId-<uuid>`) so a `LazyReferenceCollection` knows whether it has the full subset locally.

- **Granularity:** per-property model patches.
- **Joins:** the client-side object graph *is* the join — references are resolved via the Object Pool. No server-side query for multi-model views.
- **Cost:** servers stream per-row patches; clients re-render only the props that changed (MobX's sweet spot).
- **Params:** there are no per-query parameters in the resource sense — clients sync entire model classes (within their sync group). Filtering/sorting happens client-side over the in-memory pool.

### 3.7 Materialize (explicit, true IVM, the reference)

Materialize ([Materialize on differential dataflow](https://materialize.com/blog/ivm-database-replica/)) is the academic-grade reference: arbitrary SQL is compiled to *differential dataflow* (timestamped multiset deltas) and views are maintained incrementally — including aggregations, recursion, and arbitrary joins — at low ms latency. Read sets and write sets are explicit in the dataflow graph; changes propagate as `(row, time, ±1)` triples.

The lesson for our scale isn't to embed Materialize, it's that **IVM on arbitrary SQL is solved at the academic level (DBSP, [arxiv 2203.16684](https://arxiv.org/abs/2203.16684)) but the engineering cost is enormous** — hash-join state, frontier tracking, GC of stale versions. Materialite is a deliberate ~5% subset of Materialize tuned for client-side use.

### 3.8 PowerSync (explicit, bucket-level, declarative sync rules)

PowerSync ([sync rules docs](https://docs.powersync.com/usage/sync-rules/)) declares **bucket definitions** in YAML — a parameter query (extracts user/team identity) plus a data query (selects rows for that bucket).

```yaml
bucket_definitions:
  user_lists:
    parameters: SELECT request.user_id() as user_id
    data:
      - SELECT * FROM lists WHERE owner_id = bucket.user_id
```

The server consumes the Postgres logical replication slot, classifies each row change into the bucket(s) it belongs to, and streams whole buckets to whichever clients are subscribed.

- **Granularity:** bucket-level subscription, per-row delta within a bucket.
- **Joins:** none across buckets — buckets are single-table-per-data-query.
- **Cost:** O(WAL events × buckets affected). Buckets are pre-classified; per-client cost is just "send me my buckets".
- **Params:** one bucket per parameter tuple, automatically.

### 3.9 SolidJS / MobX / Vue / Angular signals (the UI-layer analogue)

These are not data-sync engines, but they solve the same shape of problem one layer up: *"a function reads some state; if any of that state changes, re-run the function."* The mechanisms are the implicit-tracking textbook:

- **SolidJS** ([Solid signals docs](https://docs.solidjs.com/concepts/signals)): a signal is a getter/setter pair; reading the getter inside a tracking scope (`createEffect`, `createMemo`, JSX) registers the current scope as a subscriber on a thread-local "current tracker" stack. Writes notify and queue a re-run. Granularity is the signal call site.
- **MobX** ([MobX understanding-reactivity](https://mobx.js.org/understanding-reactivity.html)): ES `Proxy` wraps observable objects; every property read from inside a `reaction`/`autorun` registers a dependency on that property. Per-property granularity.
- **Vue's `reactive`** is the same pattern with Proxies. **Angular signals** are SolidJS-style getters.

The takeaway: **automatic per-read tracking with a thread-local "current subscriber" stack is a 50-line primitive**. It's so cheap you can put it everywhere — and it's directly applicable to a server-side `db` proxy. A reactive `tx.select(...)` inside a query handler can register "this subscriber depends on this row range" with the same mechanism, no AST analysis required.

### 3.10 TanStack Query (the lower bar — what we already use)

TanStack Query ([invalidation docs](https://tanstack.com/query/v5/docs/framework/react/guides/query-invalidation)) is the imperative baseline. Cache keys are arbitrary tuples, and `invalidateQueries(["todos"])` matches by **prefix**, marking matching entries stale and refetching them. There is no read-set tracking at all — the developer asserts the relationship `cache key ↔ data` by writing matching invalidation calls everywhere a mutation touches related data. Our current `defineResource` is essentially TanStack Query at the server: same hand-asserted relationship, same full-payload refetch on invalidation.

## 4. Cross-framework comparison

| Framework | Dependency tracking | Update granularity | IVM? | Live joins | Pagination | Query language |
|-----------|---------------------|--------------------|----|------------|------------|----------------|
| Convex | Runtime: instrumented `ctx.db` records index ranges | Index-range invalidation, full re-run | No | Yes (imperative) | Param-keyed; full re-run on hit | JS function over `ctx.db` |
| Zero / Materialite | Static: ZQL AST → dataflow graph | Per-row delta | Yes | Yes (hash-join) | First-class operator | ZQL DSL |
| ElectricSQL | Static: shape (table + WHERE) | Per-row CDC | No (replay) | No (single-table) | Manual via `where` | SQL WHERE clause |
| Triplit | Static: relational query AST | Per-row diff | Yes | Yes (subqueries) | First-class | Custom relational |
| LiveStore | Runtime: SQLite commit hooks per table | Table-level invalidation, SQL re-run | No | Yes (SQL) | Manual | SQL |
| Linear | Runtime: MobX getters per property | Per-property patch | N/A (no relational queries) | Client-side via object pool | Client-side | None — model graph |
| Materialize | Static: SQL → differential dataflow | Per-row × time delta | Yes (full SQL) | Yes (full SQL) | First-class | SQL |
| PowerSync | Static: YAML bucket rules | Per-row inside bucket | No (replay) | No (single-table) | Per-bucket | SQL in YAML |
| SolidJS / MobX | Runtime: getter / Proxy | Per-signal / per-property | No | N/A | N/A | JS |
| TanStack Query (today) | Hand-asserted key prefix | Full payload | No | N/A | Manual via key | None |

## 5. Options for equin

Three coherent architectures, each picking a different point in the family-(a) vs family-(b) space. All assume the existing constraint: Postgres-per-worktree, single-tenant local app, plugins must register their own queries, runtime is Bun + TypeScript.

### Option A — Stay imperative, auto-track via a Drizzle proxy (Convex-style)

Keep loaders as ordinary TypeScript, but inject a wrapped `db` (call it `tx`) whose every read records into an ambient read-set. Mutations go through the same `tx`, recording writes. After a transaction commits, the engine intersects the write set against every live subscription's read set and re-runs only the ones that overlap.

```ts
defineQuery({
  key: "tasks.openInList",
  params: z.object({ listId: z.string() }),
  handler: async (tx, { listId }) =>
    await tx.select().from(tasks)
      .where(and(eq(tasks.listId, listId), eq(tasks.status, "open"))),
});

// inside a mutation
runMutation(async tx => {
  await tx.update(tasks).set({ status: "closed" }).where(eq(tasks.id, id));
  // engine records: write to `tasks`, predicate `id = <id>`
  // any live subscription whose read set overlaps that predicate is re-run
});
```

Implementation skeleton: wrap `drizzle()` so every `select`/`update`/`delete` records `{ table, predicate AST }` against the current `AsyncLocalStorage` context. The predicate AST is already in Drizzle's hands (it built the WHERE), so we get the structured form for free — no need to inspect raw SQL. Reactivity then becomes "given write `(table, row)`, find subscriptions whose predicate AST matches `row`". For complex predicates, fall back to "any row in this table" (over-invalidation, correct).

- **Issues fixed:** #1 (no manual notify — every write is observed), #2 (no `dependsOn` — read-set is computed), #14 (params are just function args, one read-set per `(handler, args)`).
- **Issues partially fixed:** #13 (loader still re-runs from scratch — but on a *narrower* trigger, no longer "any tasks change → re-run all task queries"), #3 (still full payload; needs the wire sub-design to ship row diffs).
- **Effort:** medium. ~500 lines for the proxy + read-set comparator. Plugins barely change — `defineResource(loader)` becomes `defineQuery(handler)` with a richer ctx.
- **Risks:** raw SQL escape hatches (`tx.execute(sql\`...\`)`) bypass tracking — must default to "invalidates entire table". Subqueries and CTEs need careful predicate extraction.

This is the *minimum viable* fix and the closest in spirit to what we have; effectively "Convex's tracking, on Drizzle, server-only".

### Option B — Declarative query DSL with IVM (Zero / Materialite-style)

Introduce a relational query DSL that plugins use to declare reads. The engine compiles each query to an IVM dataflow graph; Postgres logical replication feeds row deltas in; subscribers receive row deltas out.

```ts
defineLiveQuery({
  key: "tasks.openInList",
  params: z.object({ listId: z.string() }),
  query: (q, { listId }) =>
    q.from(tasks)
      .where(t => t.listId.eq(listId).and(t.status.eq("open")))
      .related("attempts", a => a.orderBy("createdAt", "desc").limit(3))
      .orderBy("createdAt", "desc"),
});
```

The runtime opens a logical replication slot per worktree DB (Postgres supports this natively, one slot per consumer), parses WAL events, and feeds them into shared dataflow graphs. The same `where status='open'` filter feeding two views becomes one shared upstream operator.

- **Issues fixed:** all of #1, #2, #3, #13, #14 — this is the cleanest, most expressive answer.
- **Effort:** large. We need (a) a query AST and type-safe builder, (b) an IVM kernel (could vendor Materialite), (c) a Postgres WAL consumer, (d) a hash-join state manager. Realistic 2–4k lines just for the core, plus per-operator bugs for years.
- **Risks:** IVM-on-joins is the dragon. Real-world join state grows linearly with the larger side; for our task/attempt/conversation join that's fine, but it's a long-term liability. Also: every query must be expressible in the DSL — escape hatches break IVM. The "query reads a file off disk" case (#12) doesn't fit at all and needs a separate primitive.

This is the *future-proof* answer but the wrong size for where we are today (single user, ~1 active worktree, low query volume).

### Option C — Implicit tracking + opt-in IVM (hybrid)

Default everything to Option A's `tx`-proxy implicit tracking. Add an opt-in `defineLiveView` that takes a *restricted* declarative query and gets IVM treatment. Plugins start imperative; performance-critical queries graduate to live views without rewriting consumers.

```ts
// Default: implicit tracking, full re-run on overlap
defineQuery({ ... handler: async (tx, args) => { ... } });

// Opt-in: declarative, IVM-maintained
defineLiveView({
  key: "tasks.openCountByList",
  query: q => q.from(tasks).where(t => t.status.eq("open")).groupBy("listId").count(),
});
```

The two layers share a wire format (per-row deltas — see the wire sub-design); the difference is just whether the engine maintains the result incrementally or re-runs the handler. Authorial effort scales with importance.

- **Issues fixed:** #1, #2, #14 immediately (via the implicit layer); #3, #13 incrementally as hot queries get promoted.
- **Effort:** start-medium, grow-large. Ship the implicit layer in week one; add the IVM operators one at a time, driven by real measured pain.
- **Risks:** two mental models to teach. Mitigated by making the imperative API the default and the IVM API the optimization.

### Recommendation

**Option C, with Option A as the v1 ship.** Get implicit tracking via a Drizzle proxy in the door first — it eliminates the entire manual-notify / `dependsOn` class of bugs immediately, with low risk and small surface. Promote individual queries to declarative IVM (Option B) as profiling shows them to be the bottleneck. Vendor Materialite if/when we cross that threshold; don't write IVM ourselves from scratch.

The one piece worth front-loading: design the **read-set representation** so it can be either a Convex-style range predicate (for Option A) or a Materialite dataflow node (for Option B). If both use a common "subscription identity" wire token, promotion is invisible to clients.

## 6. Open questions (cross-cutting other sub-designs)

1. **Wire protocol pairing.** Per-row deltas only matter if the wire can carry "row X in collection Y changed to ...". If the wire sub-design picks "always send full payload", Option A's narrower invalidation is the entire win and IVM (Option B) is wasted. Conversely, Option B forces a per-row wire format. The reactivity engine and the wire format must be co-designed.

2. **Mutation API.** Option A only works if every write goes through the tracked `tx`. Plugins that bypass it (raw `pg` calls, side-effect writes via shell out, file watchers per #12) are invisible. The mutation sub-design must standardise the entry point or define an explicit "external change" notification channel for non-DB sources.

3. **Cross-process / cross-worktree changes.** Logical replication (Option B) gives us a consumer that survives external writes; in-process tracking (Option A) doesn't. If anything ever writes the worktree DB outside the Bun process — agent does `psql`, future MCP tool, scheduled job in a sibling process — Option A misses it. Decide: are we single-process forever (issue #19), or do we plan for multi-writer?

4. **Authorization filter (issue #9 — out of scope here, but coupled).** Both options' read-set / dataflow predicates would need to compose with a per-subscriber auth predicate, and the wire delta filter needs to drop rows the subscriber can't see. Today there's no auth, but the reactivity primitives should at least leave a hook.

5. **Pagination/sort as first-class params.** Option A bakes them into `params` (each page = a separate cache entry — same problem as today, smaller). Option B can express `limit`/`offset`/`after-cursor` as IVM operators that are correctly maintained on inserts. If pagination is a near-term requirement (the conversations list is already pushing this), Option B's inevitability rises.

6. **Non-DB sources (issue #12).** Filesystem watchers, git-log scans, transcript file reads — none of these flow through `tx`. Both options need an `externalSource()` primitive that lets a plugin manually publish "this read set just got dirty"; the engine still owns subscriber notification. Decide whether that primitive is part of the reactivity engine API or a layer above.

7. **Optimistic mutations and the read-after-write contract.** When the client predicts a mutation result, the local view must reflect the predicted state until the server confirms. The reactivity engine on the server doesn't see the client's optimistic state; the client-side cache needs its own mini-IVM (or full re-run) over an "optimistic overlay". This is a client concern, but the server-side delta granularity dictates how cleanly the optimistic layer can roll back.

---

Sources:

- [How Convex Works](https://stack.convex.dev/how-convex-works)
- [Convex Docs — Reading Data](https://docs.convex.dev/database/reading-data/)
- [Convex Docs — Best Practices](https://docs.convex.dev/understanding/best-practices)
- [Convex Architecture Deep Dive — Makers' Den](https://makersden.io/blog/convex-architecture-deep-dive-reactive-database-functions-sync)
- [Zero docs — Queries](https://zero.rocicorp.dev/docs/queries)
- [rocicorp/mono](https://github.com/rocicorp/mono)
- [Marmelab — Testing Zero](https://marmelab.com/blog/2025/02/28/zero-sync-engine.html)
- [vlcn-io/materialite](https://github.com/vlcn-io/materialite)
- [Materialite walkthrough](https://github.com/vlcn-io/materialite/blob/main/demos/react/walkthrough/walkthrough.md)
- [Materialite design notes](https://github.com/vlcn-io/materialite/blob/main/notes.md)
- [ElectricSQL Shapes guide](https://electric-sql.com/docs/guides/shapes)
- [Triplit 1.0 launch](https://www.triplit.dev/blog/triplit-1.0)
- [Triplit subscribe docs](https://www.triplit.dev/docs/client/subscribe)
- [LiveStore — How it works](https://docs.livestore.dev/evaluation/how-livestore-works/)
- [Linear — Scaling the Sync Engine](https://linear.app/now/scaling-the-linear-sync-engine)
- [Reverse-engineering Linear's sync engine](https://github.com/wzhudev/reverse-linear-sync-engine)
- [Materialize — IVM Replicas](https://materialize.com/blog/ivm-database-replica/)
- [DBSP paper — Automatic IVM for Rich Query Languages (arXiv 2203.16684)](https://arxiv.org/abs/2203.16684)
- [PowerSync — Sync Rules docs](https://docs.powersync.com/usage/sync-rules/)
- [SolidJS — Signals](https://docs.solidjs.com/concepts/signals)
- [SolidJS — Intro to Reactivity](https://docs.solidjs.com/concepts/intro-to-reactivity)
- [MobX — Understanding Reactivity](https://mobx.js.org/understanding-reactivity.html)
- [TanStack Query — Invalidation](https://tanstack.com/query/v5/docs/framework/react/guides/query-invalidation)
- [Joy Gao — The Hard Things About Sync](https://expertofobsolescence.substack.com/p/the-hard-things-about-sync)
