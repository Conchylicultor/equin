# Server

Shared backend for equin. A single Bun process that routes HTTP requests and WebSocket connections to handlers provided by plugins.

See the top-level [`CLAUDE.md`](../../../../CLAUDE.md) for overall architecture and [`plugins/framework/plugins/web-sdk/CLAUDE.md`](../web-sdk/CLAUDE.md) for the frontend plugin system.

## How It Works

1. `bin/index.ts` starts `Bun.serve({ unix })` on the per-worktree Unix socket the gateway hands it as `--socket <path>` (e.g. `~/.equin/sockets/<name>.sock`), read by `readServingSocket()` (`infra/runtime-identity`). The backend errors out if it was given no socket — there is no standalone dev mode.
2. Each plugin declares its routes via a `ServerPluginDefinition` (`core/types.ts`). At startup the entry point flattens them into two lookup tables: `httpRoutes` (`"METHOD /path"` → handler) and `wsRoutes` (`"/path"` → `WsHandler`).
3. Plugins also serve live state (see "Live state" below). Append-only firehoses (terminal, log tails) use a dedicated WS route. There is no SSE path — raw `text/event-stream` in TS is forbidden (`./equin check no-raw-sse`).

## Boot modes: `serve`, `exec` and `browser`

A backend process boots in one of three modes. All run the ONE sequence in
`core/boot-stages.ts` — a second copy is the thing that rots, so add a phase
there, not in a composition root, unless it is genuinely serve-only.

- **`serve`** — the gateway-spawned, long-lived backend (`bin/index.ts`). Runs
  everything: the socket bind FIRST (before the plugin graph loads, answering 503 so the
  gateway reads a slow boot as alive, not wedged), the shared sequence with the
  route install interleaved into it, then
  the post-ready phases (`runPostReadyPhases`: the change-feed assertion,
  `onReady`, `onAllReady`), signal handlers and the orphan poll, then the
  settled phase (`runSettledPhase`: every plugin's `onSettled` — the warm-up
  drain) — last, so a SIGTERM during a long drain shuts the backend down.
- **`exec`** — a short-lived process that runs ONE registered piece of work and
  exits (`cli/run-exec.ts`, exported as `runExec` from
  `@plugins/framework/plugins/server-core/cli`). Runs load waves,
  `collectContributions`, the host-service assert, `register`, the deferred-resource bind, the preload-declare assert
  and the `onReadyBlocking` barrier, and nothing else. A failure exits 1, or the
  status the caller's `exitCodeFor(err)` picks (a supervised child: EX_TEMPFAIL
  for a database that refused it for being full).
- **`browser`** — the portable graph in a page's Web Worker
  (`core/browser-host.ts`, `bootBrowserHost({ entries, seed? })`, called from a
  plugin's `bin/browser-host.ts`). A SERVING host like `serve`, minus the
  socket: the shared sequence (no per-plugin portability assert: the graph is
  portable by construction — codegen admits only server barrels whose static
  closure needs nothing of the computer, `boundaries/core`'s
  `serverPortabilityOf`; plugins' own `wsRoutes` are not served — the page's
  transport opens any socket but `/ws/notifications` inert), runs the same
  post-ready phases as `serve` — event trigger sync, the change feed's
  LISTEN, the in-process job queue, watchers and schedules, so a write
  recomputes its readers and derives its effects as on the desktop — then
  `seed`, which therefore writes into a LIVE host through the apps' real write
  paths (and settles what it queued, `infra/jobs/in-process`'s
  `settleJobQueue`, never deriving by hand), and only then hands back the
  request router
  (`hostHttpRoutes`, the one route table `bin/index.ts` mounts too), the
  live-state socket handler and the served keys — with the settled phase
  started but not awaited (`BrowserHost.settled`; a failure is logged and
  rethrown inside `bootBrowserHost`, a test awaits it before asserting on what
  the warm-ups produce). `framework/browser-server`'s
  `serveOverPort` carries them to the page. Hosts install no probes: no heap
  reader means no memory checkpoints, no wyhash means the portable `hash64`.

| phase                                          | `serve` | `exec` | `browser` |
| ---------------------------------------------- | ------- | ------ | --------- |
| load waves, `collectContributions`, host-service assert, `register` | yes | yes | yes |
| `bindDeferredResources`                        | yes     | yes    | yes       |
| preload-declare assert                         | yes     | yes    | yes       |
| socket bind (first, 503 until routes) + route install | yes | no | no |
| `sinkHandlers` attached (in the `onReadyBlocking` graph) | yes | yes | yes      |
| `onReadyBlocking`                              | yes     | yes    | yes       |
| `markServerReady()`                            | yes     | no     | no        |
| change-feed assertion (D3), `onReady` / `onAllReady` | yes | no   | yes       |
| seed (after the post-ready phases, before serving) | no  | no     | yes       |
| settled phase (`onSettled`: the warm-up drain) | yes     | no     | yes (not awaited) |
| process crash listeners (before the graph loads) | yes | yes    | no        |
| QoS boost, signal handlers, orphan-exit poll   | yes     | no     | no        |

The **change-feed assertion** (`assertDbReadsHaveChangeFeed`, D3 of
`research/2026-10-22-global-demo-writes-render-portable-change-feed.md`) opens
the post-ready phases: a serving host whose graph registered a DB-backed
resource must have booted `network/live/change-feed` (its mark: the relation
bases it sets in `onReadyBlocking`), or boot throws "DB-backed live reads on a
host with no change feed never recompute". Only serving hosts reach it — `exec`
and partial-graph test boots (`bootPluginGraph` alone) do not.

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

### Every mode declares its namespace FIRST

A process has no ambient identity: which namespace it serves is stated by
whoever spawned it, and read back through `runtimeNamespace()`
([`infra/runtime-identity`](../../../infra/plugins/runtime-identity/CLAUDE.md)).

- **`serve`** — the gateway spawns `<spec command> --namespace <ns>`
  (`gateway/worktree.go`), the command running the composition's serving entry,
  and `bin/declare-namespace.ts` is the **literal first import** of every entry.
  It has to be first: `config_v2#machine` resolves its config dir at module
  eval, so an import placed above that line boots the process with no identity
  and fails deep in the graph with a TDZ error that names nothing.
- **Which app a serving backend is** is decided by the entry its spec's
  `command` runs (`backendEntryFor`, `infra/paths`): the committed `bin/index.ts`
  for the main composition, a gitignored `bin/index.composition.<id>.generated.ts`
  (codegen's `renderBackendEntry`, written with the composition's filtered
  registries) for any other. Each imports its registries by LITERAL path and calls
  `bin/serve.ts`, so the code a backend runs is a closure `sourceDigest` can follow
  (`boot:closure-digestable`); `serve` first refuses an entry whose registries are
  not the composition its `spec.json` declares (`assertServesComposition`). Each
  registry entry carries its plugin's core-barrel loader (`core`), the barrels the
  load waves warm. `bin/index.ts` is held equal to the render by
  `server-core:backend-entry-in-sync` — edit the template, not the file.
- **`exec`** — `runExec(namespace, body)` takes it as a parameter and declares it
  before the dynamic `import("../bin/active-runtime")`. Its caller reads it off
  its own required `--namespace <ns>` option (`supervised-exec`), which the
  spawning backend appends from `runtimeNamespace()`.
- **`browser`** — a browser host is no gateway namespace: it runs as the
  composition it serves. Its worker entry (`bin/browser-host.ts`) imports a
  `declare-namespace` module as its literal first statement (before its seed
  statically loads portable server barrels), e.g.
  `website/demos/workspace/bin/declare-namespace.ts`. Not `bootBrowserHost`'s job:
  a suite booting a host in Bun already runs as its checkout (the test preload).

It used to ride in a worktree environment variable, inherited by every
descendant forever. It cannot come back: the app's variables are declared by key
in `infra/launcher/env-names`, which has no worktree key (`launcher:env-names`).

### A sink's handler is `sinkHandlers`, never a hook

A server plugin handling a `primitives/report-sink` sink (a report sink another
plugin emits on — a missed query deadline, an ended idle transaction) lists it
as `sinkHandlers: [sinkHandler(sink, () => handler)]` (`core/sink-handler.ts`).
The framework attaches each handler in the `onReadyBlocking` graph — after the
plugin's `dependsOn` parents (a migrated DB for one that files reports), just
before its own hook — in EVERY mode, and detaches it after the `onShutdown`
hooks. A `sink.register(fn)` from a hook runs only where that hook runs: in
`onReady`, an exec child (a supervised job's body) never drains it, and the
sink held and then dropped what the child emitted. Outside `web/`, the
`report-sink/no-direct-sink-register` lint rejects the hand-rolled form.

The reporters server-core itself offers are sinks for the same reason:
`reportServerError` emits on `serverErrorSink` (held until the engine attaches),
`reportServer` — a typed report (`kind` + `data`) from a process that lives
on — on `serverReportSink` (held, recorded async), and
`exitWithFatalReport(report, exit)` — the synchronous report a process files
on its way out — on `serverFatalSink`, a REQUEST sink (never held: a report
held past the exit is lost) whose handler answers whether the durable write
landed; with none attached it says so on stderr. `exitWithFatalReport` takes
the exit (`(code) => process.exit(code)`; core has no `process`) and returns
`never`, so a synchronous disk write from a process that keeps running — which
freezes its JS thread for as long as the disk answers — has no spelling.
There is no `set*Reporter` setter to call from a hook an exec child skips.

The process's crash listeners (`uncaughtException` / `unhandledRejection`) are
the framework's for the same reason (`core/process-crash.ts`, the listeners in
`core/process-crash-listeners.ts` — outside the barrel, which a browser host
loads): each process
entry point — `serve` and `runExec` — calls `installProcessCrashListeners()`
before the graph loads (never `bootPluginGraph`, which a test runner also
boots), and they dispatch each crash to `processCrashSink`, a REQUEST sink
whose handler (the reports engine's) answers whether its synchronous write
landed. The error is always printed. An uncaught exception then exits 1; a
rejection is survived once a handler is attached (whether it was filed is
asked of `isProcessCrashHandled()`, never read off the answer: a handler that
throws answers `undefined` too). With no handler yet, another listener
owns it (the serving backend's boot-crash filer, which stands down once
`isProcessCrashHandled()`), else it is the runtime's default — exit 1, saying it
was not filed. `server-core/no-process-crash-listener` rejects any other
`process.on("uncaughtException" | "unhandledRejection", …)`.

### Two standing constraints — read before adding a boot hook

**1. `isMain()` does NOT mean "the serving backend", and an `exec` child satisfies
it.** `isMain()` asks whether this process's RUNTIME NAMESPACE is main's
(`@plugins/infra/plugins/runtime-identity/core`), and a supervised child is
handed its spawner's namespace on argv — so inside a child spawned by main's
backend it returns **true**. Nothing in the tree misbehaves today only
because every main-only side effect happens to hang off a phase `exec` skips:
cron installation (`jobs`' `onAllReady`), the graphile runners and the git
watcher's `git.refAdvanced` emit (`onReady`), the supervised-run reconciler
(`onReady`), the change-feed LISTEN consumer (`onReady`). That is a
load-bearing accident, not a guarantee — except for warm-ups: they drain in
`onSettled`, which only `runSettledPhase` calls and only a serving host calls
that, so an exec child never runs one by construction (and which host runs a
`host`-scoped one is the `warmup.host` service's answer, not `isMain()`). **Moving any
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
`spec.json` (and a serving backend refuses an entry whose registries are not the
composition that spec declares) and the database is derived from that same
namespace — so a child's
declared key set always matches the serving backend's. If those two selections
were ever allowed to disagree (a filtered-composition registry pointed at another
namespace's DB), such a hook would delete the serving backend's state. Keep the
pairing, or the scoping stops being a scope.

The QoS boost stays in `bin/serve.ts` and must not move into the shared sequence:
an `exec` child is background work spawned under a deliberately lowered priority,
and raising it to user-interactive would defeat exactly the isolation it was
spawned under.

## The boot profile, attributed and durable

`core/profiler.ts` records the boot profile (Debug → Profiling → Boot). The
plugin-graph import (`loadServerPlugins`) is the `load` phase: one
`load:wave-<n>` span per wave, and a `load:<plugin>` / `load-core:<plugin>`
span for each barrel whose import took at least `LOAD_SPAN_FLOOR_MS`. Before
this, an 11 s import gap on main was one blank between `boot-start` and
`after-import`.

A serving backend also **journals** the profile as it accrues
(`installBootJournal`, wired in `bin/index.ts`). The journal goes to the
`boot-journal` log channel (`BOOT_JOURNAL_CHANNEL`), one
`{ processStartedAt, entry }` line per entry, appended synchronously. Each
checkpoint is journaled, each load wave as it **opens** (with its plugins),
and each span past 50 ms (a wave's barrel imports only as its `slowest` three, so a boot journals ~100 lines, not ~500). The gateway's readiness deadline is a SIGKILL,
which runs no handler, so the in-memory profile dies with the process. The
journal's last `open` with no matching `span` is the wave a killed boot died
in. A slow file call during boot is recorded too, by `packages/timed-fs` →
`debug/profiling/fs-wait`.

## Host services and the `machine/` half

A capability portable server code needs from whatever host it runs on is a
**host service** (`core/host-service.ts`, `defineHostService<T>(id)`): a provider
plugin lists `Svc.provide(impl)` in its `contributions`, consumers call
`Svc.get()`. Right after `collectContributions` — which now runs BEFORE the register phase,
so a register token can read a service — `assertHostServices()` fails boot for
any declared service with zero or two providers. The desktop's
providers are `machine/` halves (booted in the same graph as `<id>#machine`
nodes). A plugin whose portable `server/index.ts` provides a service is a
**host provider** — the answer of a host without the computer
(`database/pglite`, `jobs/in-process`, the memory stores, `host-account/guest`)
— and no composition bundles one: resolution reads the fact off the barrel
itself (`plugin-meta/closure`'s `EdgeGraph.hostProviders`), so no desktop boots
two and no row lists them. Today's services: `database.driver`,
`database.migration-source`, `jobs.queue`, `log-channels.persistence`,
`attachments.blobs`, `tasks-core.push-ledger`,
`conversations.transcript-source`, `model-provider.catalog-source`,
`task-title.generator`, `config-v2.store`, `config-v2.git-layer`,
`host-account.source`, `warmup.host`, `secrets.store`,
`icons.runtime-symbol-drawer` (each declared
`export const X = defineHostService<…>("<id>")`).

- **A host provider is one file.** A fixed answer for a host without the
  computer is a sub-plugin holding only `server/index.ts`:

  ```ts
  export default {
    description: "The account of a host without the computer: …",
    contributions: [
      HostAccountSource.provide({
        read: () => Promise.resolve({ username: "demo", fullName: "Demo" }),
      }),
    ],
  } satisfies ServerPluginDefinition;
  ```

  `./equin build` writes its `package.json` (and the `CLAUDE.md` reference);
  nothing else names it — no composition row, no host list.
- **Placement is checked** (`check/`, `host-services:provider-placement`):
  every service has exactly one `machine/` provider; a service declared in a
  portable `server/` barrel (one a browser host can reach) also has exactly one
  host provider; every host provider is portable (else the check names what in
  its closure needs the computer), every binding a `server/` barrel calls
  `.provide(` on names a declared service (any other would exclude the plugin
  by mistake), and a host provider is a lone `server/` barrel — no other
  plugin folder, no sub-plugin, no importer — since leaving
  every composition takes all of those with it.
- **A service only `machine/` provides makes its declarer non-portable.**
  Portability is derived (`serverPortabilityOf`, `boundaries/core`), and one of
  its rules is this: a module declaring a service that no portable `server/`
  barrel provides needs the computer, so every server barrel loading it is not
  portable — the service is a computer-only API reached through a seam
  (`infra/claude-cli/accounts`' `ActiveClaudeAccount`,
  `apps/deploy/deploy-secrets`' `DeploySecretSource`, `infra/secrets`'
  `SecretStore` — central's store, so everything reading a secret stays off
  a browser host). Give it a host provider
  and its declarers turn portable by themselves.
- **A browser host's providers are derived, not listed.** Its graph is inferred
  from the composition it names (`codegen/core/browser-host-gen.ts`): the
  composition's portable server barrels, plus — to a fixpoint — the host
  provider of each service the graph declares, emitted as
  `hostProviders` beside `hostEntries`.
- **Identity is the plugin, not the node.** Contributions and registrations of
  a machine half are stamped with its PLUGIN id (`pluginOfNode`), so a config's
  store path or a job's "declared in" never reads `<id>#machine`.
- **A headless test is an unbooted host.** The `bun test` preload hands the
  desktop's providers (the machine halves that `.provide(` one) to
  `provideHostServicesUnbooted` (`core/testing`); `get()` reads them whenever no
  graph is booted. Booted means a collect that `assertHostServices` proved (what
  `bootPluginGraph` does) — a suite's bare `collectContributions` of a few hooks
  boots nothing, so it never takes the preload's providers from the next test
  file. Providers never switch silently: a collect over a booted graph with no
  re-assert or `clearCollectedContributions` between makes `get()` throw (a
  suite that boots in-process clears after), and a host that boots names no
  unbooted providers, so with no proven graph `get()` throws there too. A suite swapping some services for one call (its
  fixtures over the preload's, or over a faked collect's) wraps the call in
  `withHostServices(providers, fn)` (`core/testing`), which puts the previous
  answers back once it settles — never `provideHostServicesUnbooted`, which
  replaces the whole process-wide set.
- **The boot sequence is `core/boot-stages.ts`** — off the core barrel (the two
  composition roots import it by path), reachable by a suite through
  `core/testing` (`bootPluginGraph`, `serverEntries`, `serverEntryFor`).
- **Host probes.** `core` runs on every host, so the macOS memory probe (bun:ffi,
  `bin/phys-footprint.ts`) and the native snapshot hash (`Bun.hash`) are installed
  by `bin/host-probes.ts` (`installMemoryProbe`, `installHeapReader` —
  `process.memoryUsage` —, `installSnapHash`), loaded by `bin/serve.ts` and
  `bin/active-runtime.ts` (the two desktop boot modes); uninstalled (the browser
  host), `procMemory()` / `heapMemory()` answer `null` (the profiler then records
  no memory, never a made-up zero) and the snapshot hash is the portable `hash64`.

## Contribution kinds and their companions

`defineServerContribution<P>(debugName, opts?)` (`core/contributions.ts`) is a
server contribution kind; plugins list `Kind(payload)` in `contributions`, and
readers call `Kind.getContributions()` after `collectContributions`. Two
static options shape what the build does with a kind:

- `absentOnHost: { reason }` — a host may run without some contributors (the
  browser-host coverage guard's contributions arm).
- `companions: true` — opens the kind to **companions**: a contribution passing
  `companion: true` ships wherever the kind's declaring plugin ships (the
  closure engine's owner → contributor hard edge, `plugin-meta/closure`). For
  what the owner needs at runtime and cannot import, because the import would
  be a cycle: change-feed's `ChangelogRetention`, contributed by
  live-state-snapshot. Type-enforced like a web companion slot: an unflagged
  kind's input has no `companion` field (an excess property), and a cast past
  it throws at the call. Statically read — the kind's `companions: true` from
  the inline option literal of a `const`-bound `defineServerContribution(…)` in
  the owner's `server/` (parse-utils' `parseServerContributionDeclarations`),
  the contribution's flag from the inline `contributions: [ … ]` literal of the
  contributor's `server/index.ts`, its token imported by name from
  `@plugins/<owner>/server`. Never in `machine/` (both throw: a browser host
  boots the owner but no `machine/` half). Unkeyed: a server kind dispatches on
  no key space. The owner decides what a missing companion means at runtime
  (change-feed fails its serving-host `onReady`).

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

The type is intentionally flat — no base classes. A plugin is a data object with optional route maps and lifecycle hooks. Two readiness hooks: **`onReadyBlocking`** runs as a hard barrier after the routes are installed but before the server reports ready (and before any `onReady`) — use only for work that must finish before the backend can correctly serve requests (DB migrations + warmup, registry init); the gateway gates its hot-swap on the barrier completing. **`onReady`** runs after the barrier, so it observes a migrated DB and ready registry — use it for background work like pollers or watchers.

**Barrier fatality is not gated on `loadBearing`.** A throw in _any_ plugin's `onReadyBlocking` aborts boot — the barrier's contract is "this completes before we serve", so failing to complete is fatal by definition; gating it on `loadBearing` would promote degraded backends behind a green `/api/health/ready`. If blocking work is genuinely optional-for-correctness (failure should _degrade_, not crash), catch the error **inside** the hook and continue — pattern: `plugins/network/plugins/live/plugins/live-state-snapshot/server/internal/boot-init.ts`. The post-serving phases (`onReady` / `onAllReady` / `onSettled`) are the opposite: **never fatal, for any plugin** (`loadBearing` included). A throw there is printed and filed as a report (`reportServerError`, scope `plugin-hook:<id>:<hook>` — one row per plugin and hook) and the backend goes on serving. An exit there only respawned the backend into the same hook on the same data: on 2026-11-08 `conversations`' `onReady` (its boot status reconcile) hit a deterministic DB refusal and main crash-looped every ~10 s.

### Live state

Live state (anything a client wants kept in sync with server truth) is never hand-rolled WS or SSE. A plugin declares it once in `core/` with `network/live`'s `liveValue` / `liveCollection`, serves it from `server/` with `serveValue` / `serveCollection`, and spreads the served object's `declare` into its `contributions` (see [`plugins/network/plugins/live/CLAUDE.md`](../../../network/plugins/live/CLAUDE.md)):

```typescript
// server/internal/resource.ts
export const unreadServed = serveValue(notificationsUnread, { source: "db", loader: countUnread });
// server/index.ts
contributions: [...unreadServed.declare],
```

Each served resource gets `GET /api/resources/<key>/...` (HTTP fallback for WS-down / curl / SSR) and a subscription entry on the shared `GET /ws/notifications` socket; the web reads it with `useLive`.

**`defineResource` / `defineExternalResource` are the runtime primitives** (`core/resources.ts`, over `network/live/resource-runtime`) that `serveValue` / `serveCollection` compile to. Outside that substrate (and `network/live/query-resource`'s `windowQueryResource`, which it calls) and tests, no plugin calls them directly — the flat `defineResource({ … })` form survives only for tests — and the `live/no-legacy-resource-spelling` lint rejects importing them anywhere else. On those forms:

- A resource registers when `defineResource` runs; `Resource.Declare(resource)` in `contributions` is its declaration (what `...served.declare` spreads).
- **`mode` is required** on a non-keyed resource — `push` (the value rides the WS) or `invalidate` (a version stamp; each tab refetches over HTTP). It is what `liveValue`'s `load` compiles to, and there is no default.
- The two-arg form `defineResource(descriptor, serverOpts)` reads `key`, `schema` and keyed-ness (`mode: "keyed"` + `keyOf`) from the client descriptor; a keyed descriptor takes `KeyedServerResourceOptions` plus a `ScopePolicy` (a compiler-minted `routes` plan and a membership — a keyed entry is always routed), which has no `mode`, and `ServerResourceOptions.mode` excludes `"keyed"`, so a keyed resource cannot drift from its client. The flat one-arg form is push/invalidate only.
- A DB-backed resource has no `notify()` (the change feed routes commits by the loader's read-set); `defineExternalResource` is the only way to get one.
- **The loader read-set is runtime-owned** (`core/read-set.ts`): the tables each loader read, captured at the DB pool chokepoint inside the profiler's ambient loader entry and handed here by the sink runtime-profiler's install wires (`recordLoaderReadSet`). No change is routed through it — every DB-backed resource declares its reads (`routes` / `reach`), and change-feed refuses one that declares none (D6); the union is display (`_debug`), and the per-run capture is what the drift guard and the persisted `tables_read` use — so the profiler's `EQUIN_PROFILING=0` kill-switch and its profile reset leave it alone. The relation bases change-feed installs (`setRelationBases`, which throws-until-set) index every reach plan's relation reads (`indexRelationReads`). Tests read it (`getReadSetIndex`) and evict from it (`removeReadSetTable`) through `core/testing`. Its per-run capture also feeds the runtime's route drift guard (A8 — each run's own capture, handed back through `wrapLoad`'s `capture`, which `recordEntrySpan`'s `onReads` fills; `lastReadSet` for a host that hands none): a ROUTED resource (`routes` / `reach`) whose loader reads a table none of its routes names is reported once per table — and fails the load under a test runner (`strictRoutes`, on when `NODE_ENV === "test"`, which bun:test sets).
- **`Resource.Declare`'s payload** is `{ key, mode, preload?, preloadTuples?, code? }`. `code` (`PersistedCode[]`, source-digest sets read structurally) is the code a persisted value comes from: live-state-snapshot persists a preloaded key only when its Declare names it, and stamps the row with its digest. `preloadTuples` is set only by `network/live`'s `serveValue`, for a PARAMETERIZED value declared `preload`: it names and loads the tuples the boot snapshot ships (`tuples[key]`). A Declare carrying it is an enumerated preload — the boot snapshot loads it through that function, and L2 (`live-state-snapshot`) neither persists nor force-recomputes the key.

### Handlers

`WsHandler` matches Bun's native interface (`open` / `message` / `close`, over `ServerWebSocket<WsData>`). HTTP handlers are plain `(req: Request) => Response | Promise<Response>` — standard Web API types, no wrappers.

**Prefer `implement()` for new handlers.** The endpoints primitive (`@plugins/infra/plugins/endpoints/server`) wraps a plain handler with typed body/query validation, auto-serialization, and `HttpError` short-circuiting. Declare the contract once in `core/endpoints.ts` with `defineEndpoint`; use `[endpoint.route]` as the `httpRoutes` key. See [`plugins/infra/plugins/endpoints/CLAUDE.md`](../../../infra/plugins/endpoints/CLAUDE.md).

## Adding a Plugin's Server Component

Create `plugins/{name}/server/index.ts` default-exporting the `ServerPluginDefinition`, put
the implementations in `server/internal/`, and run `./equin build` — the registry is
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

Edit `plugins/{name}/server/internal/tables.ts` (or `schema.ts` for views) → run `./equin build`. The build runs `drizzle-kit generate` (writes a new SQL migration if any plugin schema changed, renamed to `YYYYMMDD_HHMMSS_<hash>__<slug>.sql`) and restarts the server, which applies pending migrations on startup. There is no separate `db:generate` step — always go through `./equin build`. First build after a schema change requires `--migration-name <slug>`; subsequent builds with no schema change don't.

### Migration runner

`plugins/database/plugins/migrations/server/` runs via the database plugin's `onReadyBlocking` hook on every server start: ensure `the applied-migrations table (`__<prefix>_migrations`) (hash PRIMARY KEY, file, applied_at)`, read the applied hashes, then run each migration file (sorted by filename timestamp) whose hash is not applied, inserting the hash in the same transaction. An applied hash with no file on disk _warns_, never errors. A DB's applied set is whatever `the applied-migrations table (`__<prefix>_migrations`)` says it is — never infer applied-ness from anything else (drizzle's legacy `drizzle.__drizzle_migrations`, file presence). No bootstrap, no legacy-drizzle branch, no auto-seeding.

A worktree's DB is a `pg_dump | pg_restore` fork of main (`plugins/database/plugins/fork/`) carrying forward **data** _and_ migration state, so a fresh fork no-ops on first start and only migrations committed after the fork timestamp execute in it. Hash-based filenames let parallel agents add migrations without collision; each worktree converges on the same applied _set_, possibly in a different order.

### Gotchas

- **Forks copy data, not just schema.** A migration running _after_ a fork sees whatever rows the source DB had at fork time. Drizzle-generated DDL is idempotent, but hand-written DML (seed inserts, backfills) can double-apply — write it idempotent (`INSERT … ON CONFLICT DO NOTHING`, `UPDATE … WHERE` guarded on current state). Data migrations are DML-only, enforced by `./equin check data-migration-dml-only`.
- **Rebased-away migrations drift silently.** Apply locally, then rebase onto a main that never merged it, and the DB keeps whatever it did. The runner warns (`applied hash X has no matching file on disk`) but does not roll back. Reinstate the file, or drop + refork.
- **Keep migrations additive** — new tables, new columns. Two agents reshaping the same object in order-dependent ways can land in reverse order in one worktree.
- **Don't hand-edit the `YYYYMMDD_HHMMSS_<hash>` prefix** — it determines sort order and the hash is content-addressed.

### Resetting a worktree DB

Do **not** hand-edit `the applied-migrations table (`__<prefix>_migrations`)` to "fix" drift — drop and re-fork:

```bash
psql -d postgres -c 'DROP DATABASE IF EXISTS "claude-<timestamp>" WITH (FORCE)'
./equin build    # recreates the worktree DB via fork + migrations
```

The server itself is spawned and supervised by the gateway; never start it manually.

## Key Design Decisions

- **Plugins own their routes** — each plugin declares routes in its `ServerPluginDefinition`, not in a central file
- **No middleware** — plugins own their paths entirely; shared concerns (auth, logging) can be added as utilities later
- **Route matching** — literal paths are matched exactly (O(1) map). Paths with `:param` segments (e.g. `GET /api/conversations/:id`) are matched linearly in registration order; captured params are passed as the second argument to the handler
- **Shared web/server code defaults to `core/`**, not a slot — see [`web-sdk/CLAUDE.md`](../web-sdk/CLAUDE.md) → "Sharing code between web and server"
- **Bun runs TypeScript directly** — no build step needed

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Core:
  - Uses:
    - `framework/http-router.createRequestHandler`
    - `framework/plugin-id.asPluginId`
    - `framework/plugin-id.isMachineNode`
    - `framework/plugin-id.machineNode`
    - `framework/plugin-id.pluginOfNode`
    - `framework/plugin-loader.computeLoadWaves`
    - `framework/plugin-loader.topoSortPlugins`
    - `framework/tooling/collected-dir.defineCollectedDir`
    - `network/live/resource-protocol.RESOURCE_HTTP_ROUTE`
    - `network/live/resource-runtime.createResourceRuntime`
    - `network/live/resource-runtime.ResourceGuardError`
    - `packages/error-subject.crashFieldsOf`
    - `packages/string-hash.hash64`
    - `primitives/report-sink.defineReportSink`
    - `primitives/report-sink.defineRequestSink`
  - Exports (types):
    - `BootJournalEntry`
    - `BootMode`
    - `BrowserHost`
    - `BrowserHostBoot`
    - `BrowserHostOptions`
    - `ChangeSource`
    - `DependsOnEntry`
    - `EndpointHttpHandler`
    - `EpochHandoffHooks`
    - `ExternalResource`
    - `HandoffState`
    - `HeapMemory`
    - `HostService`
    - `HttpHandler`
    - `HttpRoutes`
    - `KeyedServerResourceOptions`
    - `LiveStateSnapshotHooks`
    - `LoadedServerPlugin`
    - `LoaderAggregateView`
    - `LoaderReadsSink`
    - `MachineEndpointHttpHandler`
    - `MachineHttpHandler`
    - `MachinePluginDefinition`
    - `MemoryCheckpoint`
    - `MemoryProbe`
    - `PeerUsage`
    - `PeerUsageProbe`
    - `PersistedBase`
    - `PersistedCode`
    - `PersistedValueCheck`
    - `PersistMeta`
    - `PhaseId`
    - `ProcCpu`
    - `ProcessCrash`
    - `ProcessCrashEvent`
    - `ProcMemory`
    - `ProfilerEntryOptions`
    - `ProfilerHooks`
    - `ProfilerLeafOptions`
    - `ProfilerMeasureName`
    - `ProfilerSpanDetail`
    - `Registration`
    - `ReplayScope`
    - `ResourceContract`
    - `ResourceDefinition`
    - `ResourceDeliveryObserver`
    - `ResourceLike`
    - `ResourceMode`
    - `ResourceParams`
    - `ResourcePushObserver`
    - `ResumeRecord`
    - `RoutedCut`
    - `RuntimeProfileView`
    - `SeedOutcome`
    - `ServerContribution`
    - `ServerContributionToken`
    - `ServerErrorReport`
    - `ServerPluginDefinition`
    - `ServerRegistryEntry`
    - `ServerReport`
    - `ServerResourceOptions`
    - `SinkHandler`
    - `Span`
    - `TableChange`
    - `TableLayoutRequirement`
    - `WsData`
    - `WsHandler`
  - Exports (values):
    - `assertPreloadedResourcesDeclared`
    - `bindDeferredResources`
    - `BOOT_JOURNAL_CHANNEL`
    - `bootBrowserHost`
    - `boundedMembershipKeys`
    - `collectContributions`
    - `defineDeferredResource`
    - `defineExternalResource`
    - `defineHostService`
    - `defineResource`
    - `defineServerContribution`
    - `dropPendingPersists`
    - `exitWithFatalReport`
    - `getBootMode`
    - `getProfilingData`
    - `handleResourceHttp`
    - `handOffEpoch`
    - `heapMemory`
    - `hostHttpRoutes`
    - `installAsleepClock`
    - `installBootJournal`
    - `installHeapReader`
    - `installMemoryProbe`
    - `installPeerUsageProbe`
    - `installSnapHash`
    - `isProcessCrashHandled`
    - `isServerReady`
    - `keptSnapshotValue`
    - `loadResourceByKey`
    - `loadResourceFresh`
    - `machineCollectedDir`
    - `markServerReady`
    - `markServerSettled`
    - `measureSubscribeCycle`
    - `notificationsWsHandler`
    - `notifyStatsFor`
    - `onDeferredResourcesBound`
    - `onResourceDelivery`
    - `onResourcePush`
    - `peerProcUsage`
    - `persistedDefinitions`
    - `persistedKeys`
    - `physFootprintBytes`
    - `processCrashSink`
    - `procMemory`
    - `profilerStart`
    - `provideHostServicesUnbooted`
    - `recomputeResource`
    - `recordLoaderReadSet`
    - `recordMemoryCheckpoint`
    - `registeringPlugin`
    - `relationResourceReads`
    - `reportServer`
    - `reportServerError`
    - `Resource`
    - `routedTableRequirements`
    - `routeTableChange`
    - `scopedResourceTables`
    - `seedPersistedSnapshot`
    - `seedRouteDrift`
    - `serverBootState`
    - `serverCollectedDir`
    - `serverErrorSink`
    - `serverFatalSink`
    - `serverReportSink`
    - `setClientBuildIdentity`
    - `setEpochHandoffHooks`
    - `setLiveStateSnapshotHooks`
    - `setProfilerHooks`
    - `setRelationBases`
    - `setWatermarkSource`
    - `sinkHandler`
    - `triggerResourcePush`
    - `unboundedWindowKeys`
    - `unfedResourceTables`
    - `unroutedResourceKeys`
    - `validatePersistedValue`
    - `withNotifyBatch`
- Cross-plugin:
  - Imported by: 108 plugins — full list in [REFERENCE.md](./REFERENCE.md)
    - `infra` ×26
    - `debug` ×13
    - `conversations` ×11
    - `tasks` ×10
    - `database` ×9
    - `apps` ×6
    - `network` ×5
    - `reports` ×5
    - `page` ×3
    - `primitives` ×3
    - `build` ×2
    - `framework` ×2
    - `integrations` ×2
    - `ui` ×2
    - `backup`
    - `config_v2`
    - `fields/server-capabilities`
    - `ids`
    - `packages/source-digest`
    - `plugin-meta/plugin-tree`
    - `release`
    - `shell/document-head`
    - `tag-tree/engine`
- Exemptions:
  - Exempts itself from:
    - `detached-work-safety/no-raw-set-interval` — `bin/serve.ts` (sanctioned)
    - `live/no-legacy-resource-spelling` — `.` (sanctioned)
    - `server-core/no-process-crash-listener` — `core/process-crash-listeners.ts` (sanctioned)
  - Exempted by:
    - `debug/boot-events` (0 debt)
    - `framework/server-core` (0 debt)
- Cli:
  - Exports (values):
    - `loadDeclaredGraph`
    - `runExec`
- Test helpers:
  - Core: `@plugins/framework/plugins/server-core/core/testing`
    - `bootPluginGraph` — Load the plugin graph, run `register`, collect contributions, run the `onReadyBlocking` barrier.
    - `clearCollectedContributions` — Forget what was collected — back to the pre-boot state.
    - `clearRelationBases` — Back to "not set" (test support: a suite that set bases must not leak them into the next).
    - `declaredHostServiceIds` — Every declared host service's id, sorted — test support (`core/testing`): what a graph whose modules are loaded must provide.
    - `getReadSetIndex` — The whole index as a plain object, each key's tables sorted — every key that ever captured a table, including one a removal emptied (`[]`).
    - `hostServicesProvidedBy` — The ids of the declared host services `contributions` provide, sorted — test support (`core/testing`), for a suite choosing a graph's providers.
    - `isHostService` — True IFF `value` is a service `defineHostService` made — test support (`core/testing`), for a suite reading which services a module exports.
    - `isolateHostServices` — Isolate this test file's declared host services: from here on no service is declared (so a graph the suite boots is not asked for the `bun test` preload's desktop providers, and the services the suite declares are its own), and once the file's tests are done the process's declared set comes back exactly as it was — the suite's own services gone, the preload's back for every later suite in the same bun process.
    - `removeReadSetTable` — Remove `table` from the read-set of every key EXCEPT those in `keepKeys` — the one eviction path of an append-only index (a suite isolating its own keys from another's captures).
    - `runPostReadyPhases` — The post-ready phases of a SERVING host (`serve`, `browser`): `onReady` (graph-driven: each plugin fires as soon as its `dependsOn` parents have resolved), then the `onAllReady` barrier. `exec` never runs them — a short-lived child has no subscribers, so no watcher, job runner or LISTEN belongs in it.
    - `runSettledPhase` — The settled phase of a SERVING host (`serve`, `browser`): every plugin's `onSettled`, once the host is already serving and every post-ready phase has resolved — post-serving catch-up work (infra/warmup drains every declared warm-up here). `exec` has no path to it: a short-lived child must never run heavy post-serving work, and this function is the only caller of the hook.
    - `serverEntries`
    - `serverEntryFor` — The registry entry of `pluginPath`'s server barrel, as codegen writes one (`<id>` the dotted path, loaded by its `@plugins/<path>/server` specifier), with the `dependsOn` the caller states and no core barrel to warm.
    - `setServerErrorHandler` — Route every `reportServerError` to `fn` — or to nobody (`null`) — discarding whatever was held before, so a suite never receives another suite's reports.
    - `withHostServices` — Run `fn` with `providers` (each a `Svc.provide(impl)`) answering their services — over the unbooted host's providers and over a collected graph's — and put the previous answers back once it settles, so a suite swapping a service cannot leak it into the suites after it in the same bun process.

<!-- AUTOGENERATED:END -->
