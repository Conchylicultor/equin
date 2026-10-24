# Cold-load instant boot

## Context

On a fresh page load after a deploy / cold start, the UI takes ~2.3s to show
content. This surfaced as a `client-slow-op` report: the `conversation-categories`
element settled in 2345ms. Investigation showed that report — and ~9 sibling
`element` reports stamped in the same 2s window — were **not** per-resource
defects (the categories query itself is 0.28ms). They are the client-side echo of
a systemic cold start.

The metric is correct and stays: the `element` slow-op measures a live-state
resource's **mount → first-data settle**, i.e. user-perceived *time-to-content*.
A slow boot is a real UX regression, not noise (documented in
`plugins/reports/plugins/slow-ops/CLAUDE.md`). The gateway already hot-swaps only
once `GET /api/health/ready` returns 200 (after the `onReadyBlocking` barrier), so
"ready" is a contract that the next request is *fast*. Today that contract is
under-delivered. Three confirmed root causes:

1. **Boot burst, uncoalesced.** Each `useResource` mount sends one WS `sub` frame
   immediately (no batching); the server `void`-calls `handleSub` per frame, so
   ~15–25 loaders run **concurrently** against the DB pool.
2. **Pool chokepoint.** App pg Pool `max=5` through pgbouncer transaction mode
   (`default_pool_size=5`), so the burst queues behind 5 connections — observed
   `db [acquire]` ×24 @ ~1949ms. Headroom is large (PG `max_connections=500`,
   pgbouncer `max_client_conn=200`).
3. **Cold buffer cache.** `warmPool()` warms *connections* (`SELECT 1`) but not PG
   pages; the first execution of `select … from tasks_v` ran @ 4266ms cold. No
   `pg_prewarm`/VACUUM/ANALYZE anywhere.

**Outcome wanted:** the UI feels fresh and instant even on cold start.

## Approach

One shared opt-in, three consumers. A param-less global resource opts in as
**boot-critical**; the pool is sized for the burst (B), the readiness barrier
warms those resources' tables server-side before the swap (C), and the client
hydrates them in a single request before first paint (A).

### Shared opt-in (no new registry primitive)

Extend the **existing** `Resource.Declare` server contribution
(`plugins/framework/plugins/server-core/core/resources.ts:36`) payload with an
optional `bootCritical?: boolean`. A resource opts in at its existing declaration
site, e.g. `Resource.Declare(tasksResource, { bootCritical: true })`. Both
server consumers read the generic collection:
`Resource.Declare.getContributions().filter(c => c.bootCritical)` — respecting
collection-consumer separation (no consumer names a specific resource).

Add a generic loader to the runtime — the single right home for "load any
registered resource by key", routing through the same `timedLoad` path
`handleSub` uses (so warm-up/snapshot hit the identical loader+parse+profiler
span the boot burst hits):

- `plugins/framework/plugins/resource-runtime/core/runtime.ts` — add
  `loadResourceByKey(key, params?)` to the returned runtime (near runtime.ts:915):
  `const entry = registry.get(key); if (!entry) throw…; return timedLoad(entry, params ?? {})`.
  Export the type at the barrel and re-export the value through
  `server-core/core/resources.ts`.

### Phase B — Pool sizing (effort S, risk Low)

- `plugins/database/server/internal/client.ts:27` — `max: 5` → `max: 16`.
- `plugins/database/plugins/pgbouncer/scripts/start.ts:80-81` —
  `default_pool_size = 5` → `16`; leave `min_pool_size` modest (`5`, optionally `8`).

**Numbers.** Burst ≈ 15–25 concurrent loaders → `max=16` covers the realistic
~15–18 global resources one-per-connection, route-parametrized loaders share.
Aggregate budget: per worktree ≈ `16` (app via pgbouncer) + graphile-worker's
**separate direct** PG connections (concurrency 4, bypasses pgbouncer) + `adminPool`
≈ ~22; against PG `max_connections=500` → ~22 worktrees of headroom. `idleTimeoutMillis`
stays `20_000` so the burst's extra connections are reclaimed shortly after boot
(steady-state footprint stays small). Revisit only if active worktrees approach ~20.

### Phase C — Server buffer-cache warm-up (effort S/M, risk Low)

New small plugin **`plugins/infra/plugins/boot-snapshot/`** (`loadBearing: false`)
owns both server consumers. Its server `onReadyBlocking`:

```ts
async onReadyBlocking() {
  await awaitDbReady();          // from @plugins/database/server
  await migrationsReady;         // NEW export (see below) — barriers run in PARALLEL
  const keys = Resource.Declare.getContributions().filter(c => c.bootCritical).map(c => c.key);
  await Promise.allSettled(keys.map(k => withTimeout(loadResourceByKey(k), WARM_BUDGET_MS /* ~1500 */)));
}
```

- **Sequencing (the one real subtlety):** `onReadyBlocking` hooks run in **parallel**
  (`server-core/bin/index.ts:242`), so the warm-up must explicitly await migrations,
  not rely on hook order. Add a `migrationsReady` promise export to
  `plugins/database/plugins/migrations/server` that `runMigrations` resolves; the
  database plugin's own barrier (`plugins/database/server/index.ts:14`) stays pure.
- **Time-box** each loader (~1500ms) + `Promise.allSettled` so a pathological loader
  can never wedge the hot-swap. The barrier holding longer is acceptable (old backend
  serves meanwhile, zero downtime) but must be bounded. Its cost is visible as the
  `onReadyBlocking:<boot-snapshot>` profiler span.

### Phase A — Client boot-snapshot hydration (effort M, risk Med)

Eliminate the round-trips, mirroring the existing precedent
`plugins/config_v2/web/internal/boot.ts` (which already collapses all config
resources into ONE request + `hydrateResource` before paint).

- **Server endpoint** (in the boot-snapshot plugin, registered like
  `config_v2/server/index.ts:26`):
  `GET /api/resources/boot-snapshot` → `{ resources: Record<key, { value: unknown; version: number }> }`.
  Handler runs `loadResourceByKey(key)` per boot-critical key under `Promise.allSettled`
  (a failed loader is omitted, not fatal — that key falls back to its normal sub).
  `version` read the same way `handleSub` does (`entry.versions.get(pk) ?? 0`).
- **Client `Core.Boot` task** (boot-snapshot web barrel): one `fetchEndpoint(bootSnapshot)`,
  then for each key `hydrateResource(descriptor, undefined, value)`
  (`plugins/primitives/plugins/live-state/web/use-resource.ts:100`) → `pending:false`
  on first render, no WS round-trip.
- **Key → descriptor map:** `hydrateResource` needs the client `ResourceDescriptor`
  (for `schema.parse` + `queryKeyFor`); the snapshot gives only string keys. Add a web
  collection slot (e.g. `BootSnapshot.Hydrate(descriptor)`, param-less only); each
  owning plugin registers its descriptor. The boot task consumes the generic collection
  and matches by `descriptor.key`. (Opt-in is two-sided — server `bootCritical` flag +
  client descriptor registration — both declared in the same plugin. Optionally add a
  check that warns if a server boot-critical key has no client hydrate registration.)

**Scope boundary:** the snapshot covers **param-less global** resources only (tasks,
agents, conversations, conversation-categories, queue-ranks, conversation-groups,
notifications, build.history, build.mainAheadCount, agent-launches). Route-parametrized
resources (task-detail by id; edited-files / turn-summaries / commits-graph by
conversation/attempt id) are excluded — the server can't know the client's params at
snapshot time. They self-heal via their normal sub-ack, now fast because Phase C warmed
their tables. Document this in the boot task.

**Accepted in v1 (redundant sub-ack):** after hydration, `useResource` still subscribes
and the server re-runs the loader for the sub-ack. By then the cache is warm (C) and
hydrated (A), so this is fast background reconciliation that does **not** block paint.
The version-aware sub-skip (client sends hydrated `version`; server returns a value-less
ack on match) touches the missed-update watchdog (`notifications-client.ts:142,325`) and
is **explicitly out of scope** — only revisit if post-A measurement shows the sub-ack
wave still costing (it won't, once warm).

## Critical files

- `plugins/framework/plugins/server-core/core/resources.ts` — add `bootCritical` to
  `Resource.Declare`; re-export `loadResourceByKey`.
- `plugins/framework/plugins/resource-runtime/core/runtime.ts` — add `loadResourceByKey`
  via `timedLoad` (runtime.ts:253 `timedLoad`, :915 return).
- `plugins/database/server/internal/client.ts:27` — pool `max` 5→16.
- `plugins/database/plugins/pgbouncer/scripts/start.ts:80-81` — `default_pool_size` 5→16.
- `plugins/database/plugins/migrations/server/…` — export a `migrationsReady` promise.
- `plugins/infra/plugins/boot-snapshot/` (NEW) — server: `onReadyBlocking` warm-up +
  `GET /api/resources/boot-snapshot` handler; core: endpoint contract; web: `Core.Boot`
  hydration task + `BootSnapshot.Hydrate` descriptor collection.
- Each plugin owning a boot-critical resource: add `bootCritical: true` to its
  `Resource.Declare(...)` and register its descriptor in the web collection.
- Reuse precedent: `plugins/config_v2/web/internal/boot.ts`,
  `plugins/config_v2/server/index.ts:26`, `plugins/database/server/index.ts:14`.

## Verification

Deploy with `./equin build`, then measure on a fresh load of
`http://<worktree>.localhost:9000` after a restart. Inspect spans via the runtime
profiler (`get_runtime_profile` MCP / debug profiling pane) and slow-ops reports.

1. **`db [acquire]` aggregate** (Phase B): before ×24 @ ~1949ms; after, ~20 acquires
   but each sub-ms (no queueing behind 5 conns).
2. **First cold execution** (Phase C): the `select … from tasks_v` `<sql text>` span on
   the user path should be warm (low-ms); the same cold cost (~4s first time) should
   instead appear inside the `onReadyBlocking:<boot-snapshot>` span — proving it moved
   off the user path. Confirm `/api/health/ready` still flips and the swap completes.
3. **Element settle / first paint** (Phase A): boot-critical resources should report
   ~0ms settle (`reportSlowResource`, use-resource.ts:248 → slow-ops) because they're
   hydrated before first render; wall-clock time-to-content drops from ~2.3s. The
   `conversation-categories` / `tasks` / `agents` element slow-ops should stop firing
   on cold load.
4. **Barrier budget** (Phase C): compare the total `onReadyBlocking` span before/after;
   confirm the added warm time is bounded by `WARM_BUDGET_MS` and never wedges the swap.

Tests: add `bun:test` coverage for `loadResourceByKey` (unknown key throws; known key
routes through the loader) and for the boot-snapshot handler's `allSettled` omit-on-failure
behavior.
