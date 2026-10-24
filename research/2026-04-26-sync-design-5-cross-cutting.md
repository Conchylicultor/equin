# Sync redesign — cross-cutting concerns

> Sub-design 5 of the sync redesign. Addresses issues **#9 (auth has no place to live), #12 (resources can't compose with non-DB sources), #15 (debuggability is thin), #18 (forking, branching, time-travel are absent), #19 (single-process assumption)** from `2026-04-26-sync-engine-issues.md`.
>
> Other agents own the API surface, reactivity engine, wire protocol, and schema/migration layers. This doc deliberately stops at the *seams* between those layers and the cross-cutting machinery — and flags where its choices constrain or unlock theirs.

## 1. Problem restatement

equin's current sync layer treats each handler as a bare `(req, params) => Response` and each resource loader as a server-context-free `(params) => value`. Five concerns have nowhere to live: (a) caller identity / read-write authorization, (b) reactive sources that aren't a Postgres query — file watchers, `git log`, transcript JSONL tails, (c) introspection of "who is subscribed, what fired, why didn't this update", (d) speculative branching ("what if I rename these 50 tasks?") and time-travel within a single worktree, (e) running the broker outside one Bun process. These concerns interlock — auth needs a context object that observability also wants to read; branching needs an event log that observability would also use; multi-process broadcasting changes how `notify()` flows. The aim of this sub-design is to define one **request/operation context** primitive plus a small set of optional layers on top of it, so the other sub-designs can adopt them without paying the full cost up front.

---

## 2. Authorization & middleware

Today every plugin route is `(req, params) => Response`; resource loaders are `(params) => value`. There is no place to thread "who is asking" or "is this allowed" without each plugin reinventing it. The `server/CLAUDE.md` "Key Design Decisions" section openly states *"No middleware — plugins own their paths entirely; shared concerns (auth, logging) can be added as utilities later"*. That "later" is now.

### Frameworks studied

- **tRPC.** Procedures are built by chaining a `t.procedure` with `.use(middleware)`; middleware receives `{ ctx, next, input }` and may swap the context for downstream handlers via `return next({ ctx: { user: nonNull(ctx.user) } })`. The most common pattern is `protectedProcedure = t.procedure.use(({ ctx, next }) => { if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED" }); return next({ ctx: { user: ctx.user } }); })`. The context type narrows automatically across the chain ([tRPC authorization docs](https://trpc.io/docs/server/authorization), [tRPC context docs](https://trpc.io/docs/server/context)).
- **Hono.** `c.set('user', user)` plus a `Variables` generic on `createMiddleware<{ Variables: { user: User } }>()` gives you typed, accumulated context across chained `.use()` calls ([Hono middleware guide](https://hono.dev/docs/guides/middleware), [type-safety discussion](https://github.com/orgs/honojs/discussions/3257)). Built-in middlewares (`basicAuth`, `bearerAuth`, `jwt`) demonstrate the layered shape.
- **Convex.** Queries and mutations receive a `ctx` object whose `ctx.auth.getUserIdentity()` returns the JWT-derived `UserIdentity` (or `null`). Crucially, the *same* `ctx` is the entry point for the database (`ctx.db`), the scheduler (`ctx.scheduler`), and storage (`ctx.storage`) — there is one canonical "operation context" passed through every server-side function ([Convex auth in functions](https://docs.convex.dev/auth/functions-auth)).
- **Hasura / Postgres RLS.** Authorization is *declarative*: a permission rule on a table consumes session variables (`X-Hasura-User-Id`, `X-Hasura-Role`) and is compiled into a `WHERE` clause appended to every generated query ([Hasura row permissions](https://hasura.io/docs/2.0/auth/authorization/permissions/row-level-permissions/)). Postgres RLS works similarly with `SET LOCAL app.user_id = ...` and `CREATE POLICY ... USING (user_id = current_setting('app.user_id'))` ([PostgreSQL row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)).

### The pattern

Every mature sync/RPC layer threads a **single context object** through every server-side function — query, mutation, action, subscription, route handler. The context carries identity, transaction, telemetry span, request id, and pluggable extensions. Authorization is then either (a) **imperative**: middleware that throws `UNAUTHORIZED` before calling `next()` (tRPC, Hono), or (b) **declarative**: a row policy compiled into the query (Hasura, Postgres RLS). Imperative wins on flexibility (cross-table rules, rate limits, audit hooks); declarative wins on guarantee — you cannot accidentally write a query that bypasses the rule.

For equin — single-tenant local app evolving into multi-agent speculation — the imperative path is the right starting point. There is no real *user* yet, but there is already a meaningful caller distinction: human user via the gateway, agent via MCP, internal job from the queue, recursive call from another resource. Each is an *Actor* with different write rights ("agents can't drop tasks they didn't create", "MCP cannot impersonate another agent's worktree").

### Sketch — `OpCtx` as the universal first argument

```ts
// plugin-core/src/op-ctx.ts
export interface OpCtx {
  actor: Actor;                        // who is calling
  worktree: string;                    // which DB/branch we resolved to
  tx: DbTx;                            // active DB transaction (auto-committed at end)
  span: TraceSpan;                     // OTel span; auto-attached to logs
  requestId: string;                   // propagated to every notify, every log
  causedBy?: { kind: "http"|"ws"|"job"|"resource-cascade"; id: string };
  abort: AbortSignal;
}

export type Actor =
  | { kind: "human"; sessionId: string }
  | { kind: "agent"; agentId: string; conversationId: string }
  | { kind: "job";   jobId: string; name: string }
  | { kind: "system" };

// plugin-core/src/middleware.ts
export type Middleware<C extends OpCtx = OpCtx> =
  (ctx: C, next: (ctx: C) => Promise<Response>) => Promise<Response>;

export const requireAgent: Middleware = async (ctx, next) => {
  if (ctx.actor.kind !== "agent") throw new HttpError(403, "agent-only");
  return next(ctx);
};

// plugins use it the same way for both routes and resources:
defineRoute({
  method: "POST", path: "/api/tasks/:id/drop",
  use: [requireAgent, rateLimit(30, "1m"), audit("task.drop")],
  handler: async (ctx, { id }) => { /* ctx.actor is narrowed */ },
});

defineResource({
  key: "tasks",
  loader: async (ctx, params) => loadTasksVisibleTo(ctx.actor),
  // notify still fires; subscribers each get filtered through their own ctx
});
```

The constraint this places on the **API surface sub-design**: a unified primitive that handles reads + writes (replacing today's `httpRoutes` + `defineResource` split — issue #20) **must** put `OpCtx` in the first argument slot. Don't make it a hidden global (`getCurrentCtx()`) — that breaks parallel notify cascades and observability. The constraint on the **wire protocol sub-design**: every WS subscription must carry a per-socket `Actor` token established at the WS open handshake, and the broadcaster must apply the per-subscriber `OpCtx` when running the loader (or filter the value), not run it once with system creds.

---

## 3. Non-DB / external sources

Issue #12: `defineResource.loader` is "run a query". The transcript-JSONL tail (`findTranscriptPath`), the `git log` poller for stats, and the worktree FS watcher (`research/2026-04-15-global-worktree-fs-watcher.md`) all currently work by manually calling `notify()` from wherever they detect change. The boundary between "DB-backed live data" and "computed-from-the-world data" is invisible in the API.

### Frameworks studied

- **Convex** draws a hard line: **queries** must be deterministic and side-effect-free (so the engine can cache, dedupe, and re-run them); **actions** are non-deterministic and may call third-party APIs but cannot be subscribed to ([Convex queries](https://docs.convex.dev/functions/query-functions), [Convex actions](https://docs.convex.dev/functions/actions)). A subscribable view of external state must be built by an action that writes to a Convex table; the query subscribes to that table. The external world is *projected into the database*.
- **TanStack Query.** A `QueryFn` is "give me a Promise of T"; the source is opaque to the cache. Reactivity comes from `invalidateQueries(key)` calls or external refetch triggers; `useSyncExternalStore` lets the QueryObserver react to cache mutations without polling ([TanStack QueryClient](https://tanstack.com/query/v5/docs/reference/QueryClient), [QueryCache architecture](https://deepwiki.com/TanStack/query/2.1-queryclient-and-querycache)). The "external trigger" is a first-class concept: any code, anywhere, can call `client.invalidateQueries({ queryKey: [...] })`.
- **Chokidar + watch-rx.** Chokidar exposes filesystem changes as `add` / `change` / `unlink` events; `watch-rx` wraps that in an RxJS Observable so it composes with other reactive streams ([chokidar](https://github.com/paulmillr/chokidar), [watch-rx](https://github.com/tools-rx/watch-rx)). The pattern is "make the OS event a stream, then `merge` with whatever else".

### The pattern

There are two viable patterns, and a hybrid:

1. **Project the world into the DB** (Convex). Every external source becomes a "feeder" job that writes into a regular table; resources only ever read DB rows. Pure, but introduces a write-amplification step and a "what if the projection lags" problem.
2. **Make external triggers a first-class verb** (TanStack). The resource loader can be *anything* (DB query, file read, git shell-out); the resource also exposes an *`invalidate(params)`* that any external system (FS watcher, polling job, `LISTEN/NOTIFY`) can call.
3. **Hybrid with explicit `source` adapters**: declare *what* the source is (table set, file glob, polling interval, external pubsub channel), and the engine handles the trigger plumbing.

Pattern #3 is the right north star for equin — it lifts the reactive-trigger metadata out of imperative code, which is the same move that fixes issues #1, #2, and #17. But pattern #2 is a *strict subset* of #3 and is achievable today.

### Sketch — `defineSource` adapters

```ts
// plugin-core/src/sources.ts
export interface ReactiveSource<P> {
  /** Returns an unsubscribe; called when the resource has its first sub. */
  watch(params: P, onChange: () => void): () => void;
}

export const dbTableSource = (...tables: PgTable[]): ReactiveSource<unknown> => ({
  watch: (_, onChange) => trackTableWrites(tables, onChange),
});

export const fileGlobSource = (glob: (p: any) => string[]): ReactiveSource<any> => ({
  watch: (params, onChange) => {
    const w = chokidar.watch(glob(params), { ignoreInitial: true });
    w.on("all", onChange);
    return () => void w.close();
  },
});

export const pollSource = (intervalMs: number): ReactiveSource<unknown> => ({
  watch: (_, onChange) => {
    const id = setInterval(onChange, intervalMs);
    return () => clearInterval(id);
  },
});

// resource definition gains a `source` field:
defineResource({
  key: "edited-files",
  source: fileGlobSource((p) => [`${worktreeRoot(p.conv)}/**/*`]),
  loader: async (ctx, p) => collectEditedFiles(p.conv),
});

defineResource({
  key: "stats.commits",
  source: pollSource(60_000),
  loader: async (ctx, p) => parseGitLog(ctx.worktree, p.window),
});
```

The reactive engine sub-design is the natural owner of `defineSource`. The cross-cutting constraint this places on it: the engine must be source-pluggable, not hard-wired to "DB write detection". The cross-cutting constraint on the multi-process design (§6): file-watcher sources are inherently *per-process* (chokidar runs in the Bun process holding the FD); broadcasting their triggers across processes needs a fan-out channel.

A useful corollary for the **API-design** team: this plus `OpCtx` lets us model JSONL parsing, transcript tails, and live agent stdout (currently bespoke WS routes per plugin) as ordinary resources. The `terminal` and `jsonl-viewer` WS endpoints could collapse into resource subscriptions backed by `fileGlobSource` + an incremental loader.

---

## 4. Debuggability / observability

Issue #15: "Why didn't my UI update?" has six possible answers and zero per-mutation traces. The Queue debug pane shows jobs, triggers, emissions; nothing equivalent for resources.

### Frameworks studied

- **Convex Dashboard** ships a unified Logs view per request id, a live function runner, and live-updating action log lines that stream to both `npx convex logs` and the dashboard. Subscriptions are visible in the log stream as their own event type ([Convex 1.11 announcement](https://news.convex.dev/announcing-convex-1-11/), [Convex logs docs](https://docs.convex.dev/dashboard/deployments/logs)). Each function execution has a request id; clicking one log line opens "all logs for this request id".
- **Apollo Client DevTools.** A browser tab that lists active queries (with current variables and cached results), watched-query inspector, mutation log, full normalized cache tree, and a query explorer ([Apollo devtools](https://www.apollographql.com/docs/react/v2/development-testing/developer-tooling), [GitHub repo](https://github.com/apollographql/apollo-client-devtools)). The cache is the centerpiece — you can search for a field by name and see every query referencing it.
- **Materialize introspection.** Internal *catalogs* (`mz_internal.mz_dataflow_operator_parents`, `mz_arrangement_sizes`, `mz_lir_mapping`) expose every dataflow operator, its memory footprint, and a source map back to the SQL that generated it ([Materialize introspection](https://materialize.com/docs/transform-data/dataflow-troubleshooting/), [debugging blog post](https://materialize.com/blog/debugging-query-performance/)). Observability is itself a SQL-queryable view of the engine.
- **Linear's sync engine** uses MobX decorators on every model so changes are reactively observable end-to-end; transactions emit log events that can be replayed ([reverse-linear-sync-engine](https://github.com/wzhudev/reverse-linear-sync-engine), [Scaling the Linear Sync Engine](https://linear.app/now/scaling-the-linear-sync-engine)).

### The pattern

Two observations across mature systems:

1. **Request ID propagation.** A request id (or causation chain) is generated at the edge and threaded through every span — server function, DB query, downstream cascade, WS broadcast, client cache update. It's the join key for "show me everything caused by X". Convex, Apollo, OTel all do this.
2. **Introspection is itself queryable.** Materialize exposes its dataflow as SQL views; Convex exposes its function log as a streaming endpoint; Apollo exposes its cache as a tree the devtool can render. The debug surface is a *consumer of the same primitives*, not a separate logging path.

For equin, this means: the request id (already on `OpCtx`) propagates through every notify cascade, every WS push, every subscription ack — and the `_debug` endpoint becomes a *resource* like any other (`defineResource({ key: "_resources.debug", source: ... })`). The Queue debug pane and a new Resources debug pane both consume the same shape.

### Sketch — observability as a resource

```ts
// plugin-core/src/observability.ts
interface ResourceTrace {
  requestId: string;
  cause: { kind: "mutation"|"cascade"|"source-trigger"|"sub"; from?: string };
  resourceKey: string;
  paramsKey: string;
  loaderMs: number;
  subscriberCount: number;
  payloadBytes: number;
  cascadedTo: string[];               // downstream keys
  startedAt: number;
}

const recentTraces: ResourceTrace[] = [];   // ring buffer
export function recordTrace(t: ResourceTrace) { /* push, broadcast */ }

defineResource({
  key: "_debug.resources.live",
  source: dbgEventSource,             // emits when recordTrace is called
  loader: async () => ({
    sockets: [...sockets].map(snapshotSocket),
    subscriptions: [...registry].map(snapshotEntry),
    recentTraces: recentTraces.slice(-200),
  }),
});

// in the existing flushNotifies loop:
for (const params of pending) {
  const t0 = performance.now();
  const value = await entry.loader(ctx, params);
  recordTrace({
    requestId: ctx.requestId,
    cause: ctx.causedBy ?? { kind: "source-trigger" },
    resourceKey: entry.key,
    paramsKey: paramsKey(params),
    loaderMs: performance.now() - t0,
    subscriberCount: subs.length,
    payloadBytes: JSON.stringify(value).length,
    cascadedTo: entry.downstream.map(d => d.downstreamKey),
    startedAt: t0,
  });
  // ...broadcast
}
```

A `Debug.Item` "Resources" sidebar entry then renders that resource. Filter by `requestId` to answer "what did my mutation cause"; filter by `resourceKey` to answer "who's subscribed and how often does it churn"; sort by `loaderMs` to find the offender that's stalling the flush microtask.

The cross-cutting constraint on the **wire protocol sub-design**: every WS message must carry the originating `requestId` (currently messages are `{kind, key, params, value, version}` — add `requestId`). The constraint on **reactivity engine**: the cascade scheduler must propagate `causedBy` so a downstream loader run knows it was triggered by `tasks` notify, not by a fresh subscription.

---

## 5. Branching / time-travel / undo

Issue #18: each worktree is a DB fork, but inside a worktree there's no concept of "speculate, then keep or throw away", no undo at the data layer, and no replayable write log.

### Frameworks studied

- **Dolt.** A SQL database with Git semantics: `dolt branch`, `dolt commit`, `dolt merge` exposed as both CLI and stored procedures. Reads are SQL; the branch is a session variable (`USE branch_name`). Diff and log are first-class system tables ([Dolt docs](https://docs.dolthub.com/introduction/getting-started/git-for-data), [GitHub](https://github.com/dolthub/dolt)).
- **Neon.** Branching is a *storage-layer* trick: the Pageserver stores every page version (it's append-only LSN-indexed); a branch is an O(1) metadata pointer to a (timeline, LSN). New writes to the branch are copy-on-write — the parent's pages stay shared until modified ([Neon branching](https://neon.com/docs/introduction/branching), [Neon storage](https://neon.com/storage)). Compute is stateless and connects to the Pageserver, so branching doesn't need to copy compute state either.
- **PlanetScale.** Branching is at the schema level: a dev branch carries the schema of the source branch, you make changes, and merge back via a "deploy request" ([PlanetScale branching](https://planetscale.com/docs/onboarding/branching-and-deploy-requests)). Three-way merge handles non-conflicting parallel changes.
- **Replicache.** Local mutators run optimistically against a fork point; the canonical server state is fetched, the delta is computed, the speculative mutations are *replayed* on top ([Replicache local mutations](https://doc.replicache.dev/byob/local-mutations)). The mutator log is the source of truth for both speculation and undo.
- **Yjs / Automerge.** The op log *is* the state — `Automerge.getHistory(doc)` returns every change with a snapshot; `Y.UndoManager` scopes undo by transaction origin ([Y.UndoManager](https://docs.yjs.dev/api/undo-manager), [Automerge viewing history](https://www.mintlify.com/automerge/automerge/advanced/viewing-history)).
- **Event sourcing.** Branching is "fork the event stream from offset N, append divergent events, optionally merge by replaying onto the canonical stream" ([event sourcing replay](https://martinfowler.com/eaaDev/EventSourcing.html), [time travel via event sourcing](https://medium.com/@sudipto76/time-travel-using-event-sourcing-pattern-603a0551d2ff)).

### The pattern

Two orthogonal axes:

1. **Where does the branch live?** Storage (Neon), schema-only (PlanetScale), application-layer event log (Replicache, Automerge), per-process snapshot (Dolt SQL session).
2. **How is it merged?** Reset-and-replay (Replicache), three-way merge (PlanetScale, Dolt, Git), CRDT auto-merge (Automerge, Yjs), or "no merge — branches are scratch space" (Figma's branching, draft documents).

For equin's *immediate* use case ("agent speculates 50 task renames; user says yes/no"), the key insight is: **agents already work in a forked Postgres DB per worktree**. Adding *intra-worktree* branching is the missing layer. The right primitive is **scoped transactions** with persistence:

- A "scratch branch" is a Postgres `SAVEPOINT` that may live across many round trips, recorded in a `_branches` table.
- Or, more ambitious: every mutation produces an event in an append-only `_mutation_log` (id, requestId, op, args, by_actor, at). Replay is "fold this log onto the snapshot at offset N". This is the same primitive that fixes #18's undo *and* gives observability §4 its causation chain *and* gives multi-process §6 its replay-on-reconnect story.

### Sketch — branches and the mutation log

```ts
// plugin-core/src/branches.ts
export interface Branch {
  id: string;                 // "agent-spec-1234"
  parentId: string | "main";
  createdAt: number;
  createdBy: Actor;
  status: "open" | "merged" | "discarded";
}

// every mutation goes through one entrypoint that writes the log
export async function runMutation<T>(
  ctx: OpCtx,
  branch: Branch,
  op: { name: string; args: unknown },
  exec: (tx: DbTx) => Promise<T>,
): Promise<T> {
  return ctx.tx.transaction(async (tx) => {
    const result = await exec(tx);
    await tx.insert(_mutation_log).values({
      id: nextId(),
      branch: branch.id,
      requestId: ctx.requestId,
      actor: ctx.actor,
      op_name: op.name,
      op_args: op.args,
      at: new Date(),
    });
    return result;
  });
}

// branching is a savepoint + log fork:
export async function fork(ctx: OpCtx, parent: Branch): Promise<Branch> {
  const id = `branch-${ulid()}`;
  await ctx.tx.execute(sql`SAVEPOINT ${id}`);
  await ctx.tx.insert(_branches).values({
    id, parentId: parent.id, createdAt: Date.now(),
    createdBy: ctx.actor, status: "open",
  });
  return { id, parentId: parent.id, /* ... */ };
}

// commit / discard are SAVEPOINT release / rollback + log fold
// undo is "replay log up to op N-1 onto the parent snapshot"
```

The agent-side UX: "fork this worktree, run my speculation, present a diff, user keeps or drops it" maps to `fork → mutations → present diff(branch) → mergeBranch | discardBranch`.

The cross-cutting constraint on the **schema/migration sub-design**: the `_mutation_log` and `_branches` tables are *infrastructure*, not plugin tables. They sit alongside `__singularity_migrations`. Plugins must not interact with them directly. The constraint on **API surface**: every mutation must flow through `runMutation` to be loggable; this is non-negotiable if branching is to be reliable. The constraint on **reactivity**: notifies generated inside a `runMutation` must be tagged with the branch id, so subscribers in `main` don't see speculative state from a sibling branch. (This is the per-subscriber `OpCtx` filter from §2, in another guise.)

A weaker, MVP-friendly variant: **just the mutation log, no branches yet.** That alone unlocks observability (§4), undo, and "what did agent X do in the last hour" debugging — and leaves the door open for branching later.

---

## 6. Multi-process / scale

Issue #19: resources, jobs, events, and the WS broker all live in one Bun process. A long loader stalls every other subscriber. There's no story for sharing state across browser tabs (current `SharedWebSocket` already coordinates one WS per tab group, but that's still a single process on the server).

### Frameworks studied

- **Postgres `LISTEN/NOTIFY`.** Cross-process pub/sub native to the DB. Caveat: `NOTIFY` takes a global commit lock during transaction commit, so heavy multi-writer workloads serialize on it ([Recall.ai's "LISTEN/NOTIFY does not scale"](https://www.recall.ai/blog/postgres-listen-notify-does-not-scale), [PgDog scaling guide](https://pgdog.dev/blog/scaling-postgres-listen-notify)). PgBouncer transaction pooling breaks `LISTEN` (the listening session needs a dedicated connection).
- **Phoenix PubSub.** Topic-based pub/sub baked into BEAM's distributed Erlang clustering. `local_broadcast` for in-node, `broadcast` for cluster-wide; LiveView mounts subscribe to topics and re-render on broadcast ([Phoenix.PubSub docs](https://hexdocs.pm/phoenix_pubsub/Phoenix.PubSub.html), [PubSub system explainer](https://deepwiki.com/phoenixframework/phoenix/5.3-pubsub-system)). The killer feature is *transparency*: same API single-node or distributed.
- **Cloudflare Durable Objects.** Per-room actor model — one Durable Object per logical unit (chat room, document, tenant). The DO holds in-memory state, WebSockets terminate at the DO, and clients are routed to the DO that owns their room ([Durable Objects concepts](https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/), [Use WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)). Singleton-per-key, no fan-out problem because all writers and all subscribers for one key share the same actor.
- **SharedWorker browser pattern.** One JS instance per origin shared across tabs; a `MessagePort` per tab; the worker holds the WS so tabs don't reconnect ([SharedWorker tab sync](https://dev.to/jorensm/how-to-sync-react-state-across-tabs-with-workers-2mpg)).

### The pattern

The equin scaling boundary is unusual: each worktree is already its own logical "room" (its own DB, its own gateway namespace, its own Bun process). The cross-process problem inside *one* worktree is currently theoretical (we're single-process per worktree) but real for: (a) splitting hot loaders into a worker process, (b) running a leader-elected WS broker so tabs share connections, (c) the future "multi-machine" speculation Aaron Boodman gestures at in the Replicache / Zero podcast.

The cleanest model is the **Durable-Object-per-worktree** analogue: each worktree's gateway namespace owns the broker; everything else is a client of it. Inside the worktree, a single broker serializes notifies and fans out to subscribers. Cross-worktree communication is gateway-mediated (already true today). Cross-process inside a worktree (long-running loaders, jobs queue) talks to the broker over an internal channel — Postgres `LISTEN/NOTIFY` for single-machine, Redis pub/sub or NATS if we ever multi-machine.

### Sketch — broker abstraction

```ts
// plugin-core/src/broker.ts
export interface Broker {
  publish(channel: string, payload: unknown): Promise<void>;
  subscribe(channel: string, onMsg: (p: unknown) => void): () => void;
}

// in-process default — current behavior, no change
export const inProcessBroker: Broker = { /* trivial Map<string, Set<Listener>> */ };

// pg LISTEN/NOTIFY — for "multiple Bun workers in one worktree"
export function pgBroker(client: PgListenClient): Broker {
  return {
    publish: (ch, p) => client.notify(ch, JSON.stringify(p)),
    subscribe: (ch, fn) => {
      client.listen(ch, (raw) => fn(JSON.parse(raw)));
      return () => client.unlisten(ch);
    },
  };
}

// resource notify dispatches through the broker:
function scheduleNotify(entry, params) {
  entry.pendingNotifies.set(paramsKey(params), params);
  broker.publish(`resource:${entry.key}`, { params });
}
// each process holds its own subscriber set and reacts to broker messages.
```

Caveats: the `NOTIFY` global commit lock is real but our worktree workload is small (single agent + one user). For the foreseeable future, **`inProcessBroker` is fine**; the architectural value is having the seam, so we can switch implementations without touching plugin code.

For tab-level sharing, we already have a leader-elected `SharedWebSocket` (`research/2026-04-13-conversations-leader-elected-sse.md`); the broker on the server is symmetric to it.

The cross-cutting constraint on the **wire protocol sub-design**: messages should be channel-tagged so the broker can route without parsing payloads. The constraint on **reactivity engine**: the cascade scheduler must be broker-aware — a downstream notify on process A must reach subscribers on process B.

---

## 7. Cross-cutting comparison table

| Concern | Existing pattern in equin | Minimal addition | Ambitious redesign |
| --- | --- | --- | --- |
| **Auth / middleware** | Bare `(req, params) => Response`; no caller context anywhere; loaders run with system creds | Add `OpCtx` as the first arg of route + resource handlers; populate `actor` from gateway header; `requireAgent` / `requireHuman` middlewares | Declarative permissions on resources (`canRead(actor, row)`) compiled into the loader; per-subscriber filtering on broadcast |
| **Non-DB sources** | Manual `notify()` from wherever change is detected (FS watcher, git poller, JSONL tail) | `defineSource` adapters: `dbTableSource`, `fileGlobSource`, `pollSource`, `pgListenSource` | Source registry exposed as a resource; dynamic source wiring; "project the world into the DB" feeders for cross-process consistency |
| **Debuggability** | `_debug` HTTP returns subscriber counts; Queue pane for jobs only | `requestId` on `OpCtx` propagated everywhere; `_debug.resources.live` resource consumed by a Resources debug pane | Full per-mutation trace tree (mutation → cascades → broadcasts → client cache hits) with OTel export |
| **Branching / undo** | Per-worktree `pg_dump`/`pg_restore` only; no intra-worktree branching | `_mutation_log` table + `runMutation` wrapper; replay-based undo within a single branch | Full `_branches` table backed by Postgres `SAVEPOINT`s; merge / discard / diff(branch) primitives surfaced in plugins |
| **Multi-process** | Single Bun per worktree; in-memory broker; tab-level `SharedWebSocket` already exists | `Broker` interface with `inProcessBroker` default; channel-tagged notifies | `pgBroker` (or Redis/NATS) for multi-process worktrees; broker-aware cascade scheduler; durable-object-style worktree leader |

---

## 8. Options for equin

These five concerns interact. Below, each has 1–2 options chosen so they don't lock out the others.

### A. Auth / middleware

**Option A1 — `OpCtx` everywhere, imperative middleware.** Add `OpCtx` to every handler signature; provide a `Middleware` chain primitive; ship `requireAgent`, `requireHuman`, `rateLimit`, `audit` out of the box. Resources receive the *subscribing* socket's `OpCtx` on broadcast. Compatible with every other option.

**Option A2 — Declarative row policies on resources.** Each resource declares `canRead(ctx, value): boolean | filtered<value>`. The broadcaster filters per-subscriber. Stronger guarantee (you can't accidentally leak), but requires the loader's value to be filterable row-wise. Adopt only after A1 is stable.

### B. Non-DB sources

**Option B1 — `defineSource` adapters (recommended).** Resource gains an optional `source` field; engine wires the trigger automatically. FS, polling, pg-LISTEN, in-process bus all become first-class. Composes cleanly with A1, C1, D1, E1.

**Option B2 — "Actions" split à la Convex.** Force every external call into a separate "action" function that writes to a DB table; resources only read the DB. Stronger consistency, but requires a "feeder" table per source. Heavier for our local-first, low-latency use case.

### C. Debuggability

**Option C1 — `requestId` propagation + `_debug.resources.live` resource.** The same primitive (resources) is used to surface its own state. Requires the wire protocol to carry `requestId`; requires the cascade scheduler to propagate `causedBy`. Pairs with A1 (the ctx is the carrier).

**Option C2 — Add OTel spans on top of C1.** Every `OpCtx.span` is an OTel span; export to Honeycomb / local OTel collector for production-grade tracing. Strict superset of C1; defer until needed.

### D. Branching / time-travel

**Option D1 — Mutation log only (MVP).** All writes flow through `runMutation`, which appends to `_mutation_log`. No branching primitive yet. Unlocks undo, observability replay, "what did agent X do" debugging. Single-table addition.

**Option D2 — Mutation log + savepoint-backed branches.** Full `fork / mergeBranch / discardBranch`. Requires every mutation to know its branch and every notify to be branch-tagged. Bigger semantic ask on plugins; high payoff for the "agent speculation" use case which is the explicit project vision.

### E. Multi-process

**Option E1 — `Broker` interface, `inProcessBroker` default.** Add the seam; ship the trivial implementation. Zero behavior change today; we can swap implementations later. Costs almost nothing and unlocks future scale.

**Option E2 — `pgBroker` from day one.** Use Postgres `LISTEN/NOTIFY` even for the in-process case to make the wire format identical across deployments. Slight perf hit; not worth it until we actually need multi-process.

### Recommended bundle

A1 + B1 + C1 + D1 + E1. Each is a small, additive layer on the existing code. Together they form `OpCtx { actor, tx, requestId, span, branch?, broker }` — one object passed everywhere, with optional fields filled in by progressively-richer middleware. D2 and A2 become natural follow-ups once D1 + A1 ship.

---

## 9. Open questions

1. **Where does `OpCtx.tx` come from for resource loaders?** Loaders today don't run in a transaction. A subscribing client triggering a load is a *read*, not part of any user-visible mutation. Likely answer: each loader run gets its own short-lived read-only tx; mutations get a longer one wrapping the whole `runMutation`. Needs the **API-design sub-design** to confirm — they own the route/mutation lifecycle.
2. **Does the wire-protocol sub-design carry `requestId` and `branchId` per message?** This determines whether C1 and D2 are achievable cheaply. If the protocol stays at `{kind, key, params, value, version}`, observability and branching both bolt on as side channels (worse).
3. **How does the reactivity engine express "this loader read these tables / files / channels"?** Fixing issue #2 (hand-drawn `dependsOn`) probably requires the engine to *infer* dependencies from loader execution. That same mechanism is what makes B1's source adapters automatic. Ownership: reactivity-engine sub-design.
4. **Branching the FS, not just the DB.** Worktree branching today is `git worktree add` + DB fork. Intra-worktree branching (D2) only branches the DB. If an agent's speculation includes file edits, we need either a `git stash` / overlayfs trick or to scope speculation to DB-only mutations. Probably out of scope for this layer; flag for the worktree-management subsystem.
5. **Undo across plugin boundaries.** A `runMutation` records the op name and args, but redo / undo needs an inverse function. Do plugins register undo handlers (`defineMutation({ name, do, undo })`), or do we go full event-sourcing where state is *only* the fold of the log? The former is cheaper now; the latter is the cleaner long-term primitive. Depends on the **API sub-design**'s mutation primitive.
6. **Per-subscriber loader runs vs broadcast filtering.** A2 + per-actor visibility implies running the loader once per subscriber (different `ctx.actor` → different rows). Today push-mode runs the loader once and broadcasts to all. Needs reactivity-engine input on whether loaders can be made cheap enough to per-subscriber, or whether we need a "compute once, project per subscriber" intermediate.
7. **Crash recovery of the mutation log.** If the `_mutation_log` insert is in the same tx as the mutation, crashes are clean. If it's outside, we have orphan reads. Probably tx-bound; needs schema/migration team to confirm there's no surprise re ordering.

---

## Sources

- [tRPC authorization](https://trpc.io/docs/server/authorization)
- [tRPC context](https://trpc.io/docs/server/context)
- [tRPC middlewares](https://trpc.io/docs/v9/middlewares)
- [Hono middleware guide](https://hono.dev/docs/guides/middleware)
- [Hono type-safe variables](https://github.com/orgs/honojs/discussions/3257)
- [Convex auth in functions](https://docs.convex.dev/auth/functions-auth)
- [Convex queries](https://docs.convex.dev/functions/query-functions)
- [Convex actions](https://docs.convex.dev/functions/actions)
- [Hasura row-level permissions](https://hasura.io/docs/2.0/auth/authorization/permissions/row-level-permissions/)
- [PostgreSQL row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)
- [Postgres LISTEN/NOTIFY scaling (PgDog)](https://pgdog.dev/blog/scaling-postgres-listen-notify)
- [Postgres LISTEN/NOTIFY does not scale (Recall.ai)](https://www.recall.ai/blog/postgres-listen-notify-does-not-scale)
- [Phoenix.PubSub](https://hexdocs.pm/phoenix_pubsub/Phoenix.PubSub.html)
- [Phoenix PubSub system](https://deepwiki.com/phoenixframework/phoenix/5.3-pubsub-system)
- [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/)
- [Durable Objects WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [SharedWorker tab sync pattern](https://dev.to/jorensm/how-to-sync-react-state-across-tabs-with-workers-2mpg)
- [TanStack Query cache architecture](https://deepwiki.com/TanStack/query/2.1-queryclient-and-querycache)
- [TanStack QueryClient](https://tanstack.com/query/v5/docs/reference/QueryClient)
- [chokidar](https://github.com/paulmillr/chokidar)
- [watch-rx](https://github.com/tools-rx/watch-rx)
- [Convex 1.11 (live action logs)](https://news.convex.dev/announcing-convex-1-11/)
- [Convex dashboard logs](https://docs.convex.dev/dashboard/deployments/logs)
- [Apollo Client devtools](https://www.apollographql.com/docs/react/v2/development-testing/developer-tooling)
- [Apollo devtools repo](https://github.com/apollographql/apollo-client-devtools)
- [Materialize introspection](https://materialize.com/docs/transform-data/dataflow-troubleshooting/)
- [Debugging Materialize with Materialize](https://materialize.com/blog/debugging-query-performance/)
- [Reverse-engineering the Linear Sync Engine](https://github.com/wzhudev/reverse-linear-sync-engine)
- [Scaling the Linear Sync Engine](https://linear.app/now/scaling-the-linear-sync-engine)
- [Dolt — Git for Data](https://github.com/dolthub/dolt)
- [Dolt: getting started](https://docs.dolthub.com/introduction/getting-started/git-for-data)
- [Neon branching](https://neon.com/docs/introduction/branching)
- [Neon storage architecture](https://neon.com/storage)
- [PlanetScale branching and deploy requests](https://planetscale.com/docs/onboarding/branching-and-deploy-requests)
- [Replicache local mutations](https://doc.replicache.dev/byob/local-mutations)
- [Replicache: how it works](https://doc.replicache.dev/concepts/how-it-works)
- [Y.UndoManager](https://docs.yjs.dev/api/undo-manager)
- [Automerge viewing history](https://www.mintlify.com/automerge/automerge/advanced/viewing-history)
- [Event Sourcing (Martin Fowler)](https://martinfowler.com/eaaDev/EventSourcing.html)
- [Time travel via event sourcing](https://medium.com/@sudipto76/time-travel-using-event-sourcing-pattern-603a0551d2ff)
