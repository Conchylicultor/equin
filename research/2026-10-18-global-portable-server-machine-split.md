# Portable `server/` vs desktop-only `machine/`: framework and task-category's slice

Track: "Demos and client server" (wiki `block-3e397e42-…`). Subtrack: "portable server code (server/ vs
machine/)" (`block-323b766d-…`), which holds the agreed design, the measurements and the task list. This
doc is the session plan: the remaining API details (needsMachine) and the implementation order. The
worker/PGlite parts of `2026-10-18-global-browser-server-real-server-code-on-pglite.md` still apply to
the next session; its platform-shim part is superseded.

## Context

A plugin's `server/` barrel mixes portable app logic (tables, queries, endpoint handlers) with code
that needs the computer (fs, git, spawn, the pg pool, graphile). Bundling `task-category/server`
reaches 572 modules, among them pg, graphile-worker, bun:ffi and file watchers. So no plugin's real
server code can run in the browser.

Outcome of this session:
- "Can this run in the browser?" is a fact the build checks.
- Host services pick the implementation per host.
- A desktop-only endpoint or live read is declared, and the client has to handle its "not available"
  answer, enforced by tsc.
- task-category's whole closure is portable. It is proven by booting it on PGlite in a Bun test.
- The desktop app behaves exactly as before.

Decisions taken with the user this session:
1. **Enforcement:** the platform-API ban applies to every `server/`, `core/`, `shared/` and `web/`.
   - The ~122 files that violate it today get generated per-file `debt` exemptions, all under one
     tracking task.
   - A closure check proves that plugins declared portable reach no platform API transitively.
2. **Second providers now:**
   - A PGlite database driver and an in-process job queue.
   - A Bun test that boots the slice on PGlite: real migrations, seeded rows, task-categories read.
3. **needsMachine:** built for both endpoints and live reads. `launchTask` is the first real user;
   live reads are proven by type tests.

## 1. Framework

### 1a. The `machine/` folder kind

- **Vocabulary** (`framework/plugin-id/core/plugin-id.ts`):
  - Add `"machine"` to `RUNTIME_FOLDERS`.
  - tsc then forces the rows `RUNTIME_FOLDER_DOCUMENTED` (true) and `RUNTIME_FOLDER_SHIPPED` (true).
- **Boundary row** (`boundaries/core/boundary-config.ts`):
  - New row `machine: ["machine", "server", "core", "shared", "data-dirs", "deps"]`.
  - No other row lists `machine` except `cli`. So a `server/` file that imports a machine barrel is a
    boundary error, and the split spreads by itself.
- **Platform-API ban:** a new tsc-forced decision per folder in the boundaries config,
  `platformApis: Record<PluginFolder, "allowed" | "forbidden">`.
  - Forbidden: `server`, `core`, `shared`, `web`.
  - Allowed: `machine`, `central`, `cli`, `bin`, `e2e`, `provision`, `data-dirs`, `deps`, `scripts`,
    `check`, `lint`, and so on.
  - The matcher is plain data in `boundaries/core/platform-apis.ts`: every Node builtin (`node:*` and
    the bare `isBuiltin` names), `bun`, `bun:*`, `pg`, `pg-*`, `graphile-worker*`, `@parcel/watcher`,
    `drizzle-orm/node-postgres`, `bun-pty`.
  - `import type` is allowed, because it erases.
  - It is enforced as a lint rule `boundaries/no-platform-api` (IDE squiggle, exemptable).
- **Debt:** a one-off script writes, into each offending plugin's `exempt/index.ts` (merging with an
  existing one):
  `{ rule: "boundaries/no-platform-api", paths: [<each offending file>], kind: "debt", task, reason: "not yet split into server/ + machine/" }`.
  The exemptions are per file, so a new platform import elsewhere in the same plugin still fails.
- **Portable closure:** an opt-in `portable: true` on `ServerPluginDefinition` ("this plugin's server
  closure runs on every host").
  - A check `boundaries:portable-closure` finds every server barrel declaring it. It runs
    `importClosure(root, "<plugin>/server/index.ts", { dynamicImports: "cut" })` and greps
    `closure.modules` with the same matcher (the tool's `external` set omits builtins). It fails with
    `importChain` to each offender.
  - The browser host (next session) asserts at boot that every plugin it loads declares `portable`.
  - The flag is transitional: it is deleted once the debt list is empty.
- **Hardcoded runtime lists** that need a `machine` entry (tsc catches some, others are lists):
  - `plugin-boundaries` check: the R3 barrel loop at line 163 (optional barrel, like `central`), and
    the R6 cycle graph, where machine edges join the server graph.
  - `plugin-meta/plugin-tree/core/internal/plugin-tree.ts` (`Runtime`, definition parsing).
  - `facets/core/facets.ts`, the `registrations` facet, `no-reexport-default`,
    `pre-barrel-manifests-complete` and `lint/core/plugin-dirs.ts`.
  - `plugin-view/web/runtime-colors.ts`.
  - `COMPOSITION_RUNTIME_DIRS` in `codegen/core/plugin-registry-gen.ts`.
  - `exempt/core/file-category.ts`: no new category.
- **Registry:** `server-core/core/collected-dir.ts` gains `defineCollectedDir("machine")`, so codegen
  writes `server-core/core/machine.generated.ts` (`machineEntries`).
  - Check `collectEntriesWithDeps`: a machine entry's `dependsOn` must name server nodes (`x`) for
    `server` imports and machine nodes (`x#machine`) for `machine` imports, and implicitly its own
    `x`.
  - Add `machine.generated.ts` to the boundary `exclude` list, next to `server.generated.ts`.
- **Boot:**
  - `MachinePluginDefinition` (in `server-core/core/types.ts`) is
    `Omit<ServerPluginDefinition, "httpRoutes" | "portable"> & { httpRoutes?: Record<string, MachineHttpHandler> }`.
  - `bootPluginGraph` takes one entries list. `bin/index.ts` and `cli/run-exec.ts` (the desktop hosts)
    pass `[...serverEntries, ...machineEntries]`, with entries keyed `pluginPath` /
    `pluginPath#machine` in `loadServerPlugins` (`byPath`, duplicate-id check).
  - Because there is one graph, there is one `collectContributions` (it replaces `byKind`, so a second
    pass would wipe the first) and one register phase. A machine plugin's hooks run after its own
    server half's through `dependsOn`.
  - The release alias: add `@composition-machine-registry` beside `@composition-server-registry`
    (`tsconfig.base.json`, `cli/plugins/release/cli/run.ts`) if the compiled release boots machine
    entries. It must, because the desktop release is a desktop host.

### 1b. `defineHostService<T>(id)` (`server-core/core/host-service.ts`)

```ts
export const DatabaseDriver = defineHostService<DbDriver>("database.driver");
// provider plugin:
contributions: [DatabaseDriver.provide(pgDriver)]
// consumer:
DatabaseDriver.get()   // throws before collect; cached after
```

- It is built on `defineServerContribution`. It uses `contributions` rather than `register`, so the
  collected `_pluginId` names both providers in a "two providers" error, and the docs facets list
  providers for free.
- Every `defineHostService` call records its id in a module-level set.
- Right after `collectContributions`, `assertHostServices()` fails boot for any declared service with
  zero or two-plus providers, naming the service and the plugin ids.
  - A service is "declared" once its module is evaluated, so a host that loads a consumer must
    provide its services.
- `get()` before collection throws ("host services are read after boot collects contributions").

### 1c. needsMachine: endpoints (`infra/endpoints`)

**Declaration** (`core/define-endpoint.ts`):

```ts
export const launchTask = defineEndpoint({
  route: "POST /api/tasks/launch", body: …, response: …,
  needsMachine: { feature: "Launching an agent" },
});
```

- An overload returns `MachineEndpointDef<…> = EndpointDef<…> & { readonly needsMachine: MachineFeature }`.
  The existing 5 generics stay untouched.
- `unavailableMessage(feature)` is in `core`, composed once: "Launching an agent isn't available in
  this version of the app — it needs Singularity running on your computer."

**Server:**
- `implement(def, handler)` types `def` as `EndpointDef<…> & { needsMachine?: never }`, so a machine
  def is a tsc error there.
- `implementMachine(def: MachineEndpointDef, handler): MachineHttpHandler` is exported only from the
  new `endpoints/machine` barrel. `MachineHttpHandler` is `HttpHandler & { readonly [machineBrand]: true }`,
  with the brand type in `server-core/core`.
- The chain of enforcement:
  1. A handler that spawns cannot live in `server/` (lint).
  2. In `machine/`, `MachinePluginDefinition.httpRoutes` accepts only `MachineHttpHandler` (tsc). So a
     portable endpoint cannot be served by machine code alone, which would be a silent 404 in the
     browser.
  3. `implementMachine` accepts only `needsMachine` defs (tsc).
  4. Every client call site handles the unavailable arm (tsc).

**Client:**
- `Transport` (`primitives/networking/web/transport.ts`) gains a **required** `machine: boolean`. tsc
  makes every transport state it.
  - `originTransport` is `true`.
  - `browserServerTransport` is `false`.
  - The test fakes set it.
- `fetchEndpoint(machineDef, …)` returns `Promise<MachineResult<T>>`, where
  `MachineResult<T> = { kind: "ok"; value: T } | { kind: "unavailable"; message: string }`, chosen by
  a conditional type on the def. Portable defs are unchanged.
  - When `!transport.machine`, it answers `unavailable` without a request.
- `useEndpoint(machineDef)` returns `data: MachineResult<T>`.
- `useEndpointMutation(machineDef)` returns, at the **hook** level,
  `{ kind: "unavailable"; message } | ({ kind: "available" } & UseMutationResult<…>)`. A call site
  cannot reach `mutate` without narrowing. The transport is fixed per subtree, so the shape is stable
  across renders.
- `useMachineAvailability(def)` is `{ available: true } | { available: false; message }`, for gating
  UI before a click.
- Residual gap, documented: a caller can ignore an `await fetchEndpoint(machineDef)` whose value it
  doesn't read. That is acceptable for v1; the hook form is the recommended spelling.

**First user: `launchTask`.**
- It gets `needsMachine: { feature: "Launching an agent" }`.
- `handle-launch-task.ts` moves to `tasks/machine/` (`implementMachine`). The new
  `tasks/machine/index.ts` holds the route.
- `use-task-launch.ts` returns the result union. `welcome-view.tsx` and `launch-agent-popover.tsx`
  gate their launch control with `useMachineAvailability(launchTask)`: it is disabled, with the
  message as its tooltip or inline note.
- On the desktop, nothing changes visibly.

### 1d. needsMachine: live reads (`network/live`)

- **Declaration:** `liveValue(key, { …, needsMachine: { feature } })` and
  `liveCollection(key, { …, needsMachine })`. The declaration type is intersected with
  `{ readonly needsMachine: MachineFeature }`, using the same per-def pattern as `OriginField`.
- **Server:**
  - `live/server`'s `serveValue` and `serveCollection` take `{ needsMachine?: never }` declarations.
  - A new `live/machine` barrel re-exposes them for machine declarations. It is the same
    implementation: the core `serveValueOn` / `serveCollectionOn` are untouched.
- **Client:** `useLive` / `useLiveRow` return types are wrapped as
  `WithMachine<D, R> = D extends { needsMachine: MachineFeature } ? R | { status: "unavailable"; message: string } : R`
  across the overloads.
  - At runtime, when `decl.needsMachine && !transport.machine`, the hook skips subscribing (the same
    hooks are called, with the subscription disabled) and returns the unavailable arm.
  - Existing switch consumers of portable declarations are untouched.
- **Proof:** a type test with `@ts-expect-error` on reading `.data` without narrowing, and a jsdom test
  of the unavailable arm under a `machine: false` transport. There is no production user yet.

### 1e. Ambient context

- Nothing generic this session (as agreed). tasks-core's status batch moves onto the transaction: a
  `WeakMap<DbExecutor, StatusBatch>` looked up from the `exec` that `withTaskStatusChange` already
  receives.
- Trade-off, documented in place: the rung-4 `assertBatchExecutor` (a write on a different executor
  while a batch is open) loses its ambient half. It comes back with the AsyncContext primitive.

## 2. The slice: task-category's closure

**Step 0 is the measurement.** Write `boundaries:portable-closure` first, put `portable: true` on
`task-category/server`, and get the exact offender list with chains. The edges below are from the
subtrack plus this session's exploration. The check's output replaces them as the source of truth,
and any edge that wasn't foreseen is fixed the same way.

| Plugin | Stays portable in `server/` | Moves to `machine/` | Host services |
|---|---|---|---|
| **database** | `db.ts` (proxy over the driver, typed `Db` = the drizzle `PgDatabase` base both drivers share), `observe.ts` (read-table extraction, known relations, `isTransientDbError`, deadlock-retry policy), `DbExecutor`, the `onReadyBlocking` schema layer | config read (`database/core/internal/config.ts`'s `readFileSync` moves here; core keeps the pure connection-string builder), `pg.Pool`, `installQueryWrapper` lanes/gauges, `awaitDbReady`/`warmPool`, `dbLog` | `DatabaseDriver` `{ db, ready(), bootDdl(fn), listen(ch, cb), afterCommit(tx, fn) }`, where `bootDdl` carries the desktop's query deadline; `MigrationSource` `{ list(): Migration[] }` |
| database sub-plugins | `migrations` runner (reads `MigrationSource`); `derived-views` / `derived-tables` / `derived-updated-at` (portable sha256 + portable `escapeLiteral`); `ExcludeFromFork` declaration moved out of `admin` into a portable barrel | `migrations`' file listing → `migrations/machine` (provides `MigrationSource`) | — |
| **database/plugins/pglite** (new) | the PGlite driver (`drizzle-orm/pglite`), `dataDir` option, `portable: true` | — | provides `DatabaseDriver` |
| **jobs** | `defineJob`, `jobRegistry`, `JobCtx`, `NonRetryableError`, run identity, step tables, hold specs; `enqueue` → `JobQueue.get().enqueue(job, payload, { tx?, runAt?, key? })` | graphile worker, queue schema, cron, job-lock, superseded trigger, forfeit, run stats, introspection, sweeper, dead-job GC, the Debug → Jobs routes/resources, the graphile `ExcludeSchemaDataFromFork` | `JobQueue` `{ enqueue, start(jobs), stop() }` (graphile in `jobs/machine`) |
| jobs consumers of diagnostics | — | their importing files move to their own `machine/`: `debug/queue-health`, `jobs/background-arm`, `infra/events-test`, `tasks/automations` (`refreshJobSchedules`), `jobs/deadline-audit` if its sink is machine. Pure hold data (`HOLD_CLASSES`, `ceilingMsFor`, …) stays importable from jobs `core` | — |
| **jobs/plugins/in-process** (new) | in-memory queue: run on enqueue (a tx enqueue runs after commit through `afterCommit`), scheduled jobs on a one-shot timer to the next due time (portable cron in jobs `core`), lost on reload | — | provides `JobQueue` |
| **events** | unchanged (portable once jobs is) | — | — |
| **tasks-core** | all but push-ledger; status batch on tx | `push-ledger/{freshness,reaction,read-main,reconcile}.ts` → `tasks-core/machine` (`register: [pushLedgerReaction]`, `onReady: ensurePushLedgerFresh`); `queries/pushes.ts`'s pull-half call goes behind a `PushLedger` host service (machine: git reconcile, portable provider: no-op "ledger is the seed" in the PGlite composition) | `PushLedger { ensureFresh() }` |
| **attachments** | `defineLink`, tables, declarations, by-owner/file resources | file I/O (`operations`, `handle-get`, `orphan-sweep`, `paths`, root creation) → `attachments/machine` | `AttachmentBlobs { read, write, delete }`; memory provider sub-plugin for the PGlite composition |
| **log-channels** | `Log`, `defineLogSink` (declares the channel), the ring-buffer registry | `persist`, `client-ingress`, `ws-handler`, the file sink binding (`file-sink/core` stays desktop-only, imported only from machine) | `LogPersistence { sinkFor(id) }` (machine: jsonl files; portable memory provider) |
| **query-resource, derived-\*, change-feed triggers** | `createHash("sha256")` → portable sync sha256 in `packages/string-hash` (`@noble/hashes`, pinned). Identical hex digest, so nothing rebuilds on desktop | — | — |
| **server-core** | `core/phys-footprint.ts` (bun:ffi) out of `core`: `core` gets `installMemoryProbe(fn)`, and `procMemory()` / `physFootprintBytes()` delegate to it (null until installed, which consumers already handle); `bin/index.ts` installs the ffi probe; `Bun.hash` at module scope in `core/resources.ts` becomes host-installed (`bin` installs wyhash) | ffi probe → `server-core/bin/` | — |

- Fully machine sub-plugins (`connection`, `admin`'s pool/fork/backup, `client-tools`, `embedded`,
  `pgbouncer`, `fork`, `query`, `query-deadline`, the `change-feed` listener, `paths`, `worktree`,
  git plugins) **stay where they are with debt exemptions** this session. Only `machine/` code imports
  them now. Moving each one to its own `machine/` is follow-up work, done when its last `server/`
  importer is gone.
- The `Db` type widening touches about 54 files that rename `NodePgDatabase`.
  - The 6 that read `rowCount` and the 4 that read `$client` are checked by hand. A `rowCount` read
    goes through a portable `affectedRows(result)` that the driver normalises.

## 3. Proof: the slice on PGlite (Bun test)

- **Test:** `tasks/task-category/server/internal/portable-boot.test.ts` boots, through
  `bootPluginGraph({ mode: "exec" })`, the `dependsOn` closure of `task-category` from
  `serverEntries` (no machine entries), plus the portable providers: `database/pglite` (memory),
  `jobs/in-process`, the attachments memory store, the log memory sink, and the portable
  `PushLedger` provider.
  - The migration source in Bun is the files on disk, through the machine `MigrationSource` (bundled
    text is the worker session's job). That is acceptable here because only the graph under test must
    be portable, not the test harness.
- **Asserts:**
  - The boot runs migrations and the schema layer on PGlite (this also validates PG17 vs PG18).
  - Tasks and their `tasks_ext_category` rows seeded through the real tables come back from
    `task-categories` through the real `serveCollection` path.
- **Not booted:** host-service boot errors (zero/two providers) get their own unit test in
  `server-core`.

## Execution order (stop and report if a step blows up)

1. **Framework, part 1:**
   - `machine` vocabulary + rows + hardcoded lists.
   - The `no-platform-api` lint + the debt generator (file one tracking task with `add_task` first).
   - `portable` + `portable-closure` check.
   - Run it on task-category to get the real offender list.
2. **Framework, part 2:**
   - `defineHostService` + boot assert.
   - Machine registry + boot of `server + machine` entries.
   - `./singularity build` and confirm the desktop boots unchanged: the same plugin count and the same
     routes, minus none.
3. **Hashing + server-core:** the portable sha256 (verify identical digests in a test against
   `node:crypto`); phys-footprint and `Bun.hash` out of core.
4. **database split + pglite driver.** Then jobs split + in-process queue. events falls out.
5. **tasks-core** (push-ledger, status batch), **attachments**, **log-channels**. The closure check
   is green for task-category.
6. **The PGlite boot test** (§3).
7. **needsMachine on endpoints:** types, `implementMachine`, `Transport.machine`, client results,
   `launchTask` migration and its two call sites.
8. **needsMachine on live reads:** types, `live/machine`, `useLive` arm, tests.
9. **Close-out:**
   - `./singularity check` green.
   - `./singularity build`.
   - Update the subtrack card: tasks ticked, status, measurements (closure size before/after, debt
     count).
   - File the next main task (the browser worker on PGlite answering the demo), with the subtrack page
     id and the track instructions id.

## Verification

- `./singularity check`: boundary-rules, plugin-boundaries, type-check with the new lint,
  `boundaries:portable-closure`, plugins-registry-in-sync and exempt manifests valid.
- `./singularity test` on database, database/migrations, derived-views/derived-tables (digest parity),
  jobs, tasks-core (status batch, tree oracle), task-category (PGlite boot), endpoints (needsMachine
  types + unavailable), network/live (unavailable arm) and server-core (host service asserts).
- `./singularity build` and then `http://<worktree>.localhost:9000`:
  - The task list groups by category.
  - Launching an agent from Welcome still works.
  - Debug → Jobs and Queue health still render.
  - Boot logs show the same plugin set, now with `#machine` nodes.
- `/demo`: the launch control shows "Launching an agent isn't available in this version…" (its
  transport is `machine: false`).

## Follow-ups (not this session)

- The browser worker host on PGlite answering the demo, with migrations from bundled text (next main
  task).
- config_v2 split.
- Moving the fully machine sub-plugins to their own `machine/`.
- Taking `data-dirs` and `deps` out of the `server` row.
- The AsyncContext primitive and polyfill.
- A durable `JobQueue` for the local app.
- Paying down the debt list.
