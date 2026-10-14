# Server

Shared backend for Singularity. A single Bun process that routes HTTP requests and WebSocket connections to handlers provided by plugins.

See the top-level [`CLAUDE.md`](../../../../CLAUDE.md) for overall architecture and [`plugins/framework/plugins/web-sdk/CLAUDE.md`](../web-sdk/CLAUDE.md) for the frontend plugin system.

## How It Works

1. `bin/index.ts` starts `Bun.serve({ unix })` on the per-worktree Unix socket the gateway hands it as `--socket <path>` (e.g. `~/.singularity/sockets/<name>.sock`), read by `readServingSocket()` (`infra/runtime-identity`). The backend errors out if it was given no socket — there is no standalone dev mode.
2. Each plugin declares its routes via a `ServerPluginDefinition` (`core/types.ts`). At startup the entry point flattens them into two lookup tables: `httpRoutes` (`"METHOD /path"` → handler) and `wsRoutes` (`"/path"` → `WsHandler`).
3. Plugins also serve live state (see "Live state" below). Append-only firehoses (terminal, log tails) use a dedicated WS route. There is no SSE path — raw `text/event-stream` in TS is forbidden (`./singularity check no-raw-sse`).

## Boot modes: `serve` and `exec`

A backend process boots in one of two modes. Both run the ONE sequence in
`shared/boot-stages.ts` — a second copy is the thing that rots, so add a phase
there, not in a composition root, unless it is genuinely serve-only.

- **`serve`** — the gateway-spawned, long-lived backend (`bin/index.ts`). Runs
  everything: the shared sequence, with the socket bind interleaved into it, then
  `onReady`, `onAllReady`, `drainWarmups`, signal handlers and the orphan poll.
- **`exec`** — a short-lived process that runs ONE registered piece of work and
  exits (`cli/run-exec.ts`, exported as `runExec` from
  `@plugins/framework/plugins/server-core/cli`). Runs load waves, `register`,
  `collectContributions`, the deferred-resource bind, the preload-declare assert
  and the `onReadyBlocking` barrier, and nothing else.

| phase                                          | `serve` | `exec` |
| ---------------------------------------------- | ------- | ------ |
| load waves, `register`, `collectContributions` | yes     | yes    |
| `bindDeferredResources`                        | yes     | yes    |
| preload-declare assert                         | yes     | yes    |
| socket bind                                    | yes     | no     |
| `onReadyBlocking`                              | yes     | yes    |
| `markServerReady()`                            | yes     | no     |
| `onReady` / `onAllReady` / `drainWarmups`      | yes     | no     |
| QoS boost, signal handlers, orphan-exit poll   | yes     | no     |

The **preload-declare assert** (`assertPreloadedResourcesDeclared`,
`core/resources.ts`) throws when a resource registered with `preload` has no
`Resource.Declare` contribution carrying it, naming every such key. The boot
snapshot and the L2 persist set read `preload` off the Declare set only, so a
forgotten `...served.declare` would otherwise serve but silently lose boot
hydration and persistence — and the barrier's L2 sweep, which `exec` runs too,
would delete the key's persisted row. That is why it runs in both modes and
before the barrier.

**`bindDeferredResources`** (`core/resources.ts`) runs right after
`collectContributions`: a deferred resource (`defineDeferredResource` — a
`network/live` collection whose fields other plugins contribute — exposures,
scoped column sets, union arms) compiles its
server half from contributions, which exist only now, and must be bound before
the preload assert reads the registry and before the barrier's change feed
rebuilds triggers from the route layout. Then it runs every check registered
with `onDeferredResourcesBound` (a cross-check over what the binds consumed,
e.g. "every contribution names a collection served here"); a throw from a bind
or a check fails boot, so such a
graph never serves.

### Both modes declare their namespace FIRST

A process has no ambient identity: which namespace it serves is stated by
whoever spawned it, and read back through `runtimeNamespace()`
([`infra/runtime-identity`](../../../infra/plugins/runtime-identity/CLAUDE.md)).

- **`serve`** — the gateway spawns `… bin/index.ts --namespace <ns>`
  (`gateway/worktree.go`), and `bin/declare-namespace.ts` is the **literal first
  import** of `bin/index.ts`. It has to be first: `plugins-active.ts` selects the
  plugin registry at module eval, and `config_v2` resolves its config dir at
  module eval, so an import placed above that line boots the process with no
  identity and fails 83 plugins deep with a TDZ error that names nothing.
- **`exec`** — `runExec(namespace, body)` takes it as a parameter and declares it
  before the dynamic `import("../bin/active-runtime")`. Its caller reads it off
  its own required `--namespace <ns>` option (`supervised-exec`), which the
  spawning backend appends from `runtimeNamespace()`.

It used to ride in a `SINGULARITY_WORKTREE` environment variable, inherited by
every descendant forever; `namespace-identity/no-ambient-worktree-env` keeps it
from coming back.

### Two standing constraints — read before adding a boot hook

**1. `isMain()` does NOT mean "the serving backend", and an `exec` child satisfies
it.** `isMain()` asks whether this process's RUNTIME NAMESPACE is main's
(`@plugins/infra/plugins/runtime-identity/core`), and a supervised child is
handed its spawner's namespace on argv — so inside a child spawned by main's
backend it returns **true**. Nothing in the tree misbehaves today only
because every main-only side effect happens to hang off a phase `exec` skips:
cron installation (`jobs`' `onAllReady`), the graphile runners and the git
watcher's `git.refAdvanced` emit (`onReady`), the supervised-run reconciler
(`onReady`), the change-feed LISTEN consumer (`onReady`), host-scoped warm-ups
(`drainWarmups`). That is a load-bearing accident, not a guarantee. **Moving any
main-only work into `register` or `onReadyBlocking` makes an exec child do it** —
installing duplicate crontab items, emitting ref-advanced events, or adopting and
writing off supervised runs including the one that spawned it.

**2. Everything in `onReadyBlocking` must be idempotent AND cheap when nothing
changed.** The barrier now has two callers, and an `exec` child boots precisely
when a serving backend is already up and busy — so a hook that writes
unconditionally takes locks on tables the live backend is reading.

The shape to copy, where it applies: `rebuildDerivedViews` and the change-feed's
`rebuildTriggers` record a content signature in the DB and return early when it
matches, so a steady-state boot is a read. **That is sound only because their
output IS their definition** — recreate a view or a trigger from the same text and
you get the same object. It does NOT transfer to anything holding rows.
`rebuildDerivedTables` rebuilds a materialized rollup, whose correctness depends
on source DATA; its reconcile is documented as the self-heal for "drift from
downtime / bulk loads", and the rollup declarations explicitly say the reconcile
is the safety net _regardless of_ their trigger-completeness argument. A definition
signature cannot observe that drift, so skipping on one would trade a boot cost
for a silently stale rollup. Split the two halves before reaching for a signature:
definition DDL can be signature-skipped, a rebuild-from-source cannot. That split
is now implemented — see `plugins/database/plugins/derived-tables/CLAUDE.md`.

**The accepted residual: every `exec` child still runs a full rollup reconcile
before it can start its work.** That is a deliberate trade, not an oversight. The
definition half — including the trigger DDL that locks `conversations` /
`pushes` — is skipped when unchanged, per source table, so an exec child no
longer contends with the live backend for a hot source table. What remains is a
diff-first scan against the rollup that writes nothing when nothing drifted: it
costs boot latency and blocks nothing. If an exec child ever proves too slow to boot because of it, that is a
measured problem wanting a measured fix — a bounded or incremental reconcile, or
moving repair off the boot path with an explicit invalidation. **The fix is NOT to
put the reconcile behind the definition signature**: rollups are feed-exempt, so a
silently stale rollup has nothing to invalidate it and no reader would ever learn
it was wrong.

**3. A blocking hook that scopes a write by the DECLARED resource/plugin set is
safe only while registry selection and DB selection agree.**
`live-state-snapshot`'s `sweepUnusableSnapshots` DELETEs persisted snapshot rows
that are not usable — keys the runtime no longer persists, another definition, an
older writer. That is a no-op in an `exec` child today
because `bin/active-runtime.ts` selects the registry from the namespace's own
`spec.json` and the database is derived from that same namespace — so a child's
declared key set always matches the serving backend's. If those two selections
were ever allowed to disagree (a filtered-composition registry pointed at another
namespace's DB), such a hook would delete the serving backend's state. Keep the
pairing, or the scoping stops being a scope.

The QoS boost stays in `bin/index.ts` and must not move into the shared sequence:
an `exec` child is background work spawned under a deliberately lowered priority,
and raising it to user-interactive would defeat exactly the isolation it was
spawned under.

## ServerPluginDefinition

Each server plugin default-exports a `ServerPluginDefinition`. `id` is not authored — the loader derives it from the plugin's hierarchy path:

```typescript
import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

const plugin: ServerPluginDefinition = {
  httpRoutes: { "GET /api/tasks": handleList },
  wsRoutes: { "/ws/terminal": wsHandler },
};
export default plugin;
```

The type is intentionally flat — no base classes. A plugin is a data object with optional route maps and lifecycle hooks. Two readiness hooks: **`onReadyBlocking`** runs as a hard barrier after the socket binds but before the server reports ready (and before any `onReady`) — use only for work that must finish before the backend can correctly serve requests (DB migrations + warmup, registry init); the gateway gates its hot-swap on the barrier completing. **`onReady`** runs after the barrier, so it observes a migrated DB and ready registry — use it for background work like pollers or watchers.

**Barrier fatality is not gated on `loadBearing`.** A throw in _any_ plugin's `onReadyBlocking` aborts boot — the barrier's contract is "this completes before we serve", so failing to complete is fatal by definition; gating it on `loadBearing` would promote degraded backends behind a green `/api/health/ready`. If blocking work is genuinely optional-for-correctness (failure should _degrade_, not crash), catch the error **inside** the hook and continue — pattern: `plugins/database/plugins/live-state-snapshot/server/internal/boot-init.ts`. `loadBearing` still gates the post-serving `onReady` / `onAllReady` phases, where killing a live backend is reserved for critical plugins.

### Live state

Live state (anything a client wants kept in sync with server truth) is never hand-rolled WS or SSE. A plugin declares it once in `core/` with `network/live`'s `liveValue` / `liveCollection`, serves it from `server/` with `serveValue` / `serveCollection`, and spreads the served object's `declare` into its `contributions` (see [`plugins/network/plugins/live/CLAUDE.md`](../../../network/plugins/live/CLAUDE.md)):

```typescript
// server/internal/resource.ts
export const unreadServed = serveValue(notificationsUnread, { source: "db", loader: countUnread });
// server/index.ts
contributions: [...unreadServed.declare],
```

Each served resource gets `GET /api/resources/<key>/...` (HTTP fallback for WS-down / curl / SSR) and a subscription entry on the shared `GET /ws/notifications` socket; the web reads it with `useLive` / `useLiveRow`.

**`defineResource` / `defineExternalResource` are the runtime primitives** (`core/resources.ts`, over `framework/resource-runtime`) that `serveValue` / `serveCollection` compile to. Outside that substrate (and `infra/query-resource`'s `windowQueryResource`, which it calls) and tests, no plugin calls them directly — the flat `defineResource({ … })` form survives only for tests — and the `live/no-legacy-resource-spelling` lint rejects importing them anywhere else. On those forms:

- A resource registers when `defineResource` runs; `Resource.Declare(resource)` in `contributions` is its declaration (what `...served.declare` spreads).
- **`mode` is required** on a non-keyed resource — `push` (the value rides the WS) or `invalidate` (a version stamp; each tab refetches over HTTP). It is what `liveValue`'s `load` compiles to, and there is no default.
- The two-arg form `defineResource(descriptor, serverOpts)` reads `key`, `schema` and keyed-ness (`mode: "keyed"` + `keyOf`) from the client descriptor; a keyed descriptor takes `KeyedServerResourceOptions` plus a `ScopePolicy` (a compiler-minted `routes` plan and a membership — a keyed entry is always routed), which has no `mode`, and `ServerResourceOptions.mode` excludes `"keyed"`, so a keyed resource cannot drift from its client. The flat one-arg form is push/invalidate only.
- A DB-backed resource has no `notify()` (the change feed routes commits by the loader's read-set); `defineExternalResource` is the only way to get one.
- **The loader read-set is runtime-owned** (`core/read-set.ts`): the tables each loader read, captured at the DB pool chokepoint inside the profiler's ambient loader entry and handed here by the sink runtime-profiler's install wires (`recordLoaderReadSet`). It is ROUTING state — the legacy router (`applyLegacyFullChange`) inverts it through the relation bases change-feed installs (`setRelationBases`, which throws-until-set), memoized on its version counter — so the profiler's `SINGULARITY_PROFILING=0` kill-switch and its profile reset leave it alone. `seedReadSetIndex` / `removeReadSetTable` are its boot seed and eviction; tests read it through `core/testing`. Its per-run capture also feeds the runtime's route drift guard (A8, `lastReadSet`): a ROUTED resource (`routes` / `reach`) whose loader reads a table none of its routes names is reported once per table — and fails the load under a test runner (`strictRoutes`, on when `NODE_ENV === "test"`, which bun:test sets).
- **`Resource.Declare`'s payload** is `{ key, mode, preload?, preloadTuples? }`. `preloadTuples` is set only by `network/live`'s `serveValue`, for a PARAMETERIZED value declared `preload`: it names and loads the tuples the boot snapshot ships (`tuples[key]`). A Declare carrying it is an enumerated preload — the boot snapshot loads it through that function, and L2 (`live-state-snapshot`) neither persists nor force-recomputes the key.

### Handlers

`WsHandler` matches Bun's native interface (`open` / `message` / `close`, over `ServerWebSocket<WsData>`). HTTP handlers are plain `(req: Request) => Response | Promise<Response>` — standard Web API types, no wrappers.

**Prefer `implement()` for new handlers.** The endpoints primitive (`@plugins/infra/plugins/endpoints/server`) wraps a plain handler with typed body/query validation, auto-serialization, and `HttpError` short-circuiting. Declare the contract once in `core/endpoints.ts` with `defineEndpoint`; use `[endpoint.route]` as the `httpRoutes` key. See [`plugins/infra/plugins/endpoints/CLAUDE.md`](../../../infra/plugins/endpoints/CLAUDE.md).

## Adding a Plugin's Server Component

Create `plugins/{name}/server/index.ts` default-exporting the `ServerPluginDefinition`, put
the implementations in `server/internal/`, and run `./singularity build` — the registry is
generated, never hand-edited (root `CLAUDE.md` → "Registry exclusivity").

`server/` may import its own `core/`, `shared/` and `data-dirs/` (relative) and other
plugins' `server`, `core` and `data-dirs` barrels — never `web/`, its own included (root
`CLAUDE.md` → "Plugin boundary rules"). Tests sit beside the code as `*.test.ts` and import
it by relative path; a helper other server suites reuse goes in `server/testing/index.ts`
(`@plugins/{name}/server/testing`), or in `core/testing/` when web tests use it too — never
in the public `server/index.ts`.

## Path Aliases

`@plugins/*` is declared **once** in the root `tsconfig.base.json` and inherited via
`extends`; it resolves relative to the base file, so the same entry is correct at every depth
and `tsconfig-alias-single-owner` fails any tsconfig that re-adds a local copy. Third-party
server deps (e.g. `bun-pty`) go in the plugin's own `package.json` — no alias needed.

## How requests reach the backend

`/api/*` and `/ws/*` are proxied by the gateway over the per-worktree Unix socket — the backend has no TCP listener at all. Static assets are served by the gateway. See [`gateway/CLAUDE.md`](../../../../gateway/CLAUDE.md) for the full request-routing rules.

## Database

Drizzle ORM + Postgres, one DB per namespace — the process's own runtime namespace picks the database name.

- Each plugin defines its tables in `plugins/{name}/server/internal/tables.ts` and any derived views/Zod schemas in `plugins/{name}/server/internal/schema.ts`.
- `plugins/database/plugins/migrations/core/drizzle.config.ts` discovers plugin schemas via glob (`plugins/**/server/**/internal/{tables,schema}.ts`) — there is **no central aggregator file**. Adding a new plugin's tables requires no edits outside that plugin.
- `@plugins/database/server` exports `db = drizzle(pool)` without a schema object — the codebase uses the SQL builder API (`db.select().from(...)`), not drizzle's relational query API (`db.query.<table>`), so no runtime schema aggregation is needed.
- Migrations live in `plugins/database/plugins/migrations/data/` (committed to git).

### Schema change workflow

Edit `plugins/{name}/server/internal/tables.ts` (or `schema.ts` for views) → run `./singularity build`. The build runs `drizzle-kit generate` (writes a new SQL migration if any plugin schema changed, renamed to `YYYYMMDD_HHMMSS_<hash>__<slug>.sql`) and restarts the server, which applies pending migrations on startup. There is no separate `db:generate` step — always go through `./singularity build`. First build after a schema change requires `--migration-name <slug>`; subsequent builds with no schema change don't.

### Migration runner

`plugins/database/plugins/migrations/server/` runs via the database plugin's `onReadyBlocking` hook on every server start: ensure `__singularity_migrations (hash PRIMARY KEY, file, applied_at)`, read the applied hashes, then run each migration file (sorted by filename timestamp) whose hash is not applied, inserting the hash in the same transaction. An applied hash with no file on disk _warns_, never errors. A DB's applied set is whatever `__singularity_migrations` says it is — never infer applied-ness from anything else (drizzle's legacy `drizzle.__drizzle_migrations`, file presence). No bootstrap, no legacy-drizzle branch, no auto-seeding.

A worktree's DB is a `pg_dump | pg_restore` fork of main (`plugins/database/plugins/fork/`) carrying forward **data** _and_ migration state, so a fresh fork no-ops on first start and only migrations committed after the fork timestamp execute in it. Hash-based filenames let parallel agents add migrations without collision; each worktree converges on the same applied _set_, possibly in a different order.

### Gotchas

- **Forks copy data, not just schema.** A migration running _after_ a fork sees whatever rows the source DB had at fork time. Drizzle-generated DDL is idempotent, but hand-written DML (seed inserts, backfills) can double-apply — write it idempotent (`INSERT … ON CONFLICT DO NOTHING`, `UPDATE … WHERE` guarded on current state). Data migrations are DML-only, enforced by `./singularity check data-migration-dml-only`.
- **Rebased-away migrations drift silently.** Apply locally, then rebase onto a main that never merged it, and the DB keeps whatever it did. The runner warns (`applied hash X has no matching file on disk`) but does not roll back. Reinstate the file, or drop + refork.
- **Keep migrations additive** — new tables, new columns. Two agents reshaping the same object in order-dependent ways can land in reverse order in one worktree.
- **Don't hand-edit the `YYYYMMDD_HHMMSS_<hash>` prefix** — it determines sort order and the hash is content-addressed.

### Resetting a worktree DB

Do **not** hand-edit `__singularity_migrations` to "fix" drift — drop and re-fork:

```bash
psql -d postgres -c 'DROP DATABASE IF EXISTS "claude-<timestamp>" WITH (FORCE)'
./singularity build    # recreates the worktree DB via fork + migrations
```

The server itself is spawned and supervised by the gateway; never start it manually.

## Key Design Decisions

- **Plugins own their routes** — each plugin declares routes in its `ServerPluginDefinition`, not in a central file
- **No middleware** — plugins own their paths entirely; shared concerns (auth, logging) can be added as utilities later
- **Route matching** — literal paths are matched exactly (O(1) map). Paths with `:param` segments (e.g. `GET /api/conversations/:id`) are matched linearly in registration order; captured params are passed as the second argument to the handler
- **Shared web/server code defaults to `core/`**, not a slot — see [`web-sdk/CLAUDE.md`](../web-sdk/CLAUDE.md) → "Sharing code between web and server"
- **Bun runs TypeScript directly** — no build step needed

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Core:
  - Uses:
    - `framework/resource-runtime.createResourceRuntime`
    - `framework/tooling/collected-dir.defineCollectedDir`
  - Exports (types):
    - `BootMode`
    - `ChangeSource`
    - `DependsOnEntry`
    - `ExternalResource`
    - `HttpHandler`
    - `KeyedServerResourceOptions`
    - `LiveStateSnapshotHooks`
    - `LoadedServerPlugin`
    - `LoaderAggregateView`
    - `MemoryCheckpoint`
    - `PersistedBase`
    - `PersistedValueCheck`
    - `PersistMeta`
    - `PhaseId`
    - `ProcMemory`
    - `ProfilerHooks`
    - `ProfilerMeasureName`
    - `ProfilerSpanDetail`
    - `Registration`
    - `ResourceContract`
    - `ResourceDefinition`
    - `ResourceDeliveryObserver`
    - `ResourceLike`
    - `ResourceMode`
    - `ResourceParams`
    - `ResourcePushObserver`
    - `RuntimeProfileView`
    - `SeedOutcome`
    - `ServerContribution`
    - `ServerContributionToken`
    - `ServerFatalReport`
    - `ServerPluginDefinition`
    - `ServerResourceOptions`
    - `Span`
    - `TableChange`
    - `TableLayoutRequirement`
    - `WsData`
    - `WsHandler`
  - Exports (values):
    - `applyLegacyFullChange`
    - `assertPreloadedResourcesDeclared`
    - `bindDeferredResources`
    - `boundedMembershipKeys`
    - `collectContributions`
    - `defineDeferredResource`
    - `defineExternalResource`
    - `defineResource`
    - `defineServerContribution`
    - `dropPendingPersists`
    - `getBootMode`
    - `getProfilingData`
    - `handleResourceHttp`
    - `isServerReady`
    - `keptSnapshotValue`
    - `loadResourceByKey`
    - `markServerReady`
    - `measureSubscribeCycle`
    - `notificationsWsHandler`
    - `notifyStatsFor`
    - `onDeferredResourcesBound`
    - `onResourceDelivery`
    - `onResourcePush`
    - `persistedDefinitions`
    - `persistedKeys`
    - `physFootprintBytes`
    - `procMemory`
    - `profilerStart`
    - `recomputeResource`
    - `recordLoaderReadSet`
    - `recordMemoryCheckpoint`
    - `registeringPlugin`
    - `removeReadSetTable`
    - `reportServerError`
    - `reportServerFatalSync`
    - `Resource`
    - `routedTableRequirements`
    - `routeTableChange`
    - `scopedResourceTables`
    - `seedPersistedSnapshot`
    - `seedReadSetIndex`
    - `serverCollectedDir`
    - `setClientBuildIdentity`
    - `setErrorReporter`
    - `setFatalReporter`
    - `setLiveStateSnapshotHooks`
    - `setProfilerHooks`
    - `setRelationBases`
    - `triggerResourcePush`
    - `unboundedWindowKeys`
    - `validatePersistedValue`
    - `withNotifyBatch`
- Cross-plugin:
  - Imported by:
    - `infra/audio-analysis`
    - `infra/deps`
    - `infra/jobs/supervised-job`
- Exemptions:
  - Exempts itself from:
    - `detached-work-safety/no-raw-set-interval` — `bin/index.ts` (sanctioned)
    - `live/no-legacy-resource-spelling` — `.` (sanctioned)
- Cli:
  - Exports (values): `runExec`
- Test helpers:
  - Core: `@plugins/framework/plugins/server-core/core/testing`
    - `clearRelationBases` — Back to "not set" (test support: a suite that set bases must not leak them into the next).
    - `getReadSetIndex` — The whole index as a plain object, each key's tables sorted — every key that ever captured a table, including one a removal emptied (`[]`).

<!-- AUTOGENERATED:END -->
