# Browser server: the plugins' real server code on PGlite (first slice)

> **Superseded (2026-10-18) — split first, no platform stand-ins.** After this plan was written, the
> decision moved to splitting each plugin's server code into a portable `server/` and a desktop-only
> `machine/`, with host services per host. The design lives in the wiki subtrack "Subtrack: portable
> server code (server/ vs machine/)" (`block-323b766d-7ddf-4555-820a-80d82d6737f3`). Still valid from
> this doc: the worker host and `browser` boot mode, the PGlite driver, migrations from bundled
> text, the seed, the page-side `workerBrowserServer`, and `needsMachine`. Dropped: §2 (platform
> shims / `unenv`) and the scaffolding ledger.

Track: "Demos and client server" (wiki `block-3e397e42-…`, track card `block-d04c6c0d-…`, reuse sub-page `block-5aef55da-…`).

## Context

The `/demo` sandbox runs the real resource runtime and router in the page, but no real server code answers it. Every answer is either the hand-written agent-manager pack or one of about 18 per-plugin "none" stubs (`Demo.Resource`). Every new read on main breaks the demo silently (four did in one week, among them `task-categories`). Each stub also adds to what has to be migrated later.

Target model: the app runs unchanged. Its plugins' real server code answers on an in-browser database, which starts empty for a local app or seeded for a demo. Features the browser cannot run are declared as unavailable in the server API, and the app is forced by the type system to show a clear message for them.

**This session proves that model on one slice.** Real plugin server code boots in the page (a Web Worker) on PGlite, against a database built by the real migrations and seeded with demo rows. One demo read that is broken today, `task-categories` and its registry, is answered by `tasks/task-category`'s own server code. Endpoints that need the machine get a typed declaration.

## What measurement showed (all numbers from this session)

- **Server barrels are fat, so the browser can't use a curated subset of files.**
  - Bundling `task-category/server`, or even one of its files, reaches 572 modules across 106 plugins. Most of that comes from `tasks-core/server`.
  - Even a small plugin (`app-usage`) reaches 419 modules.
  - The full server registry is 4,100 modules, including vite, eslint, playwright, sharp and typescript. So the worker boots a chosen set of plugins, not the whole registry.
- **The browser-incompatible leaves are few and come from substrate code.**
  - A slice's closure has about 26–32 barrels that import a platform API: `fs`, `os`, `path`, `crypto`, `async_hooks`, `worker_threads`, `pg`, `graphile-worker`, `@parcel/watcher`, `bun:ffi`.
  - They are database connection/admin/migrations, jobs, paths, spawn, flock, host-admission, log-channels, file-sink, watchers, and `server-core/core/phys-footprint`.
  - Plugin app logic itself is portable.
- **Migrations are small: 325 files, 440 KB.** So the real migration runner can run in the browser on bundled text. No schema-dump stage is needed.
- **The database uses only `plpgsql`.** PGlite tracks PG17 against our PG18. No migration uses PG18-only syntax (`uuidv7`, `VIRTUAL`, `WITHOUT OVERLAPS`, `NOT ENFORCED`).
- **`drizzle-orm@0.36.4` already ships `drizzle-orm/pglite`.** `@electric-sql/pglite` is not a dependency yet.
- **server-core's resource runtime is a module-level singleton** that `defineResource` registers into at import. That is why the browser host must be a **Worker**: its own realm, the analogue of a process, where those singletons are correct as they are.

## Approach: server code unchanged, platform shimmed, substrate injected by the host

The split sits where the host differs (the platform and the substrate), so everything above it (plugin server code) is shared as is. This is the "abstraction layer at the point where server vs client-server diverge" from the track page. Splitting every plugin into portable and host barrels was rejected. It would touch about 30 foundational plugins over several sessions, while the platform split needs a handful of seams.

### 1. A third boot mode: `browser` (server-core)

- `server-core/shared/boot-stages.ts` gains a `browser` arm in `BootSpec`, beside `serve` and `exec`. It reuses the same sequence (load waves, `register`, `collectContributions`, `bindDeferredResources`, the `onReadyBlocking` barrier), so there is still one boot sequence.
- **What the `browser` arm skips, and the arm's hard rule:**
  - It skips QoS, signals, `markServerReady`, the socket bind and warmups.
  - It runs only the `onReadyBlocking` hooks of the plugins it boots.
  - A hook that touches the platform fails loudly, and it is fixed in place, never skipped.
- **Composition root** (worker entry): it is exposed through a server-core barrel a `bin/` file may import, and never through `core/`, so it stays off the web graph. It takes:
  - the registry entries to boot;
  - the database driver;
  - a `seed(db)`.
- **Serving in the worker:**
  - **Requests:** it collects `httpRoutes` plus `RESOURCE_HTTP_ROUTE` exactly as `bin/index.ts` does, through `createRequestHandler` (`framework/http-router/core`).
  - **Socket:** it maps `server-core/core`'s `notificationsWsHandler` onto a MessagePort.
  - **Protocol:** one generic message protocol carries `request` (serialized Request/Response) and `socket` (open, frame, close).
- **Host-agnostic runtime:** `server-core/core/resources.ts` stops referencing `Bun.hash` at module scope. `snapHash` is set by the host: `bin/index.ts` installs wyhash, and the browser keeps the runtime's portable `hash64`.

### 2. Platform shims (build-time resolver, browser-server)

- **The worker bundle** is built with `Bun.build({ target: "browser" })` and a resolver plugin owned by `framework/browser-server`:
  - **Node builtins** go to `unenv`'s browser implementations. `path`, `events` and `url` are real. Anything unsupported throws at call time, naming the API.
  - **`bun:ffi`, `bun:jsc` and `bun-pty`** go to modules whose every export throws `HostUnavailableError("<api>")`.
  - **`pg` and `graphile-worker`** stay bundled, inert. Nothing calls them, because the substrate below is injected.
- **Imports must never fail.** Calls fail loudly, naming what the browser lacks.
- **Load-time side effects** that touch the platform are made lazy in place, such as `paths/core`'s module-scope `homedir()` if it misbehaves. Laziness is good hygiene on Bun too.
- **Build step:** it discovers each `bin/browser-server.ts` entry, emits it into the web dist, and writes a generated manifest. Web code gets the worker URL from the manifest, never from a hand-written path.
- **Size gate:** the bundle size is logged. The slice is expected at a few MB plus about 3 MB of PGlite WASM. Optimisation is a later task.

### 3. Substrate injected by the host

- **Database:** `database/server`'s `db` proxy gets a host seam, `installDbDriver(drizzleDb)`.
  - The browser root installs `drizzle(new PGlite())` from `drizzle-orm/pglite`, in memory for this slice.
  - Bun keeps its lazy `pg.Pool` path, so there is no behaviour change there.
  - The one type cast (`PgliteDatabase` to the `NodePgDatabase` that consumers are typed against) lives at the seam, with a comment.
  - Pool-only paths (gates, `pool.query`, deadlines) fail loudly if reached.
- **Migrations:** the runner gets a text-input seam next to `listMigrationFiles(dir)`. It takes `{ name, sqlText }[]` and feeds the existing pure `planSchemaSteps` and `runSteps`.
  - The worker bundles `migrations/data/*.sql` as text.
  - It runs `runMigrations` and then `applySchemaLayer(db, { views, derivedTables, updatedAtSpecs })` from the booted graph's contributions. This is the same code as `database/server`'s `onReadyBlocking`.
- **Hashes:** `node:crypto` `createHash("sha256")` in derived-views, derived-tables, change-feed and query-resource moves to a portable synchronous sha256 (for example `@noble/hashes`, behind `packages/string-hash`). The digest is identical, so Bun does not rebuild any view or rollup.
- **Change feed:** the worker sets relation bases at boot (`setRelationBases`, from the derived-views graph), because reads assert it.
  - `pglite.listen("live_state")` feeding the existing consumer is the next slice, with writes.
  - Seeded reads don't need it.
- **Jobs:** `defineJob` still registers. Enqueueing throws `HostUnavailableError("background jobs")`. There is no in-worker scheduler in this slice.

### 4. Page side: the worker is just another `BrowserServer`

- **The worker as a `BrowserServer`:** `framework/browser-server/web` adds `workerBrowserServer(url)`. It implements the existing `BrowserServer` interface (`request`, `connect`, `dispose`) over the MessagePort protocol, so `browserServerTransport` and every app call path stay unchanged.
- **Transitional bridge, to delete:** the pack, the stubs and the config backend still live in DemoScope's page-side server. For the slice, that server forwards every key it does not serve to the worker, as a host option, replacing `DemoMissingError` for those keys.
  - **Loader:** `GET /api/resources/:key` on the worker.
  - **Changes:** the worker posts `{ key, params }` from `onResourcePush`, and the page calls `notify`.
  - **Worker misses:** a key the worker does not serve either stays a loud `unserved` error there.
  - **Ends when:** stubs and pack move into the worker, after which the page server is deleted. This is a later session.

### 5. The demo's worker root and seed

- **Worker root:** `apps/agent-manager/plugins/demo/bin/browser-server.ts` (a `bin/` root may import plugin defaults):
  - It boots `[database, tasks-core, task-category, …the plugins whose TaskCategory contributions the seeded tasks use]`.
  - It seeds through the real drizzle tables: the pack's `task-demo-*` tasks, plus their `tasks_ext_category` rows.
  - Seed ids match the pack, so the pack's task rows and the real categories describe the same tasks.
  - The explicit plugin list is scaffolding until a composition generates it. That is the track's Composition task.
- **Scenario:** `DemoScenario` gains the worker manifest id. DemoScope starts the worker, and nothing else in it changes.

### 6. Browser-unavailable features, declared and type-enforced (`infra/endpoints`)

- **Declaration:** `defineEndpoint({ …, needsMachine: { feature: "Launching an agent" } })`. A machine endpoint cannot be declared without naming the feature.
- **Host:** `implement()` answers a `needsMachine` endpoint with `409 { reason: "unavailable", feature }` before running the handler, when the host lacks the machine.
  - The host capability is set once by each composition root: Bun `machine: true`, the browser `false`.
  - Reading the capability unset throws.
- **Client:** `fetchEndpoint`, `useEndpoint` and `useEndpointMutation` of a `needsMachine` endpoint return `{ kind: "ok", value } | { kind: "unavailable", message }`, chosen by a conditional type on the def.
  - The `message` is composed once from `feature`: "Launching an agent isn't available in this version of the app — it needs Singularity running on your computer."
  - Call sites cannot reach the value without handling the unavailable arm. That is tsc enforcement, not a lint.
- **Slice scope:**
  - Mark the machine endpoints the agent-manager demo reaches: launch/start agent, send turn, push. Take the list from the leak ledger in `research/2026-10-13-global-in-app-demo-scope-v2.md`.
  - Fix their call sites (tsc lists them).
  - The existing `unsupported` 409 stays for unmatched routes.
- **Next, not this slice:** the same declaration on `liveValue` / `liveCollection` (transcripts on disk, Claude CLI status), surfacing an `unavailable` arm from `useLive`.

## Execution order (spike first; stop and report if a step blows up)

1. **Spike: bundle and evaluate.** Bundle a worker root booting `task-category` with the shims, load it in a headless page, and list what throws at module evaluation and at boot. If more than about 10 in-place laziness fixes are needed, stop and re-plan.
2. Seams: `installDbDriver`, migration text input, portable sha256, host `snapHash`, the `browser` boot mode. Bun behaviour stays unchanged; check this with `./singularity test` on the touched plugins.
3. Worker host plus `workerBrowserServer`; the page server's forward-to-worker option.
4. Demo root and seed; DemoScope wiring; `task-categories` and the registry answered by real code.
5. `needsMachine` on endpoints plus host short-circuit plus client result type; mark the demo's machine endpoints and fix call sites.
6. Update the track card (status, tasks, the PGlite measurements); file the next main task.

## Critical files

- `plugins/framework/plugins/server-core/shared/boot-stages.ts`, `core/resources.ts`, a new browser composition root.
- `plugins/framework/plugins/browser-server/` (shim resolver, build step, `workerBrowserServer`, forward option in `core/internal/browser-server.ts`).
- `plugins/database/server/internal/client.ts` (driver seam), `plugins/database/plugins/migrations/server/internal/runner.ts` (text input).
- `plugins/database/plugins/{derived-views,derived-tables,change-feed}/server`, `plugins/infra/plugins/query-resource/server` (portable sha256).
- `plugins/infra/plugins/endpoints/core/{define-endpoint,implement,unsupported}.ts`, `web/internal/fetch-endpoint.ts`, `use-endpoint*.ts`.
- `plugins/framework/plugins/browser-server/plugins/demo/plugins/scope/web/components/demo-scope.tsx`, `plugins/apps/plugins/agent-manager/plugins/demo/{core,bin}`.
- New dependencies: `@electric-sql/pglite`, `unenv`, `@noble/hashes` (pinned).

## Verification

- `./singularity build`, then open `http://<worktree>.localhost:9000/demo`.
  - The agent-manager task list groups by category from real rows.
  - The network panel shows no `/api/resources/task-categories` request leaving the page.
  - The worker's console logs boot timings: migrations, schema layer, seed.
- An e2e script, `agent-manager/demo/e2e/real-server.ts`, asserts the category sections render in `/demo` and that clicking a machine action shows the declared "isn't available in this version" message.
- `./singularity test` on database/migrations, endpoints and browser-server, plus a unit test of the worker protocol and of `needsMachine` typing (a `@ts-expect-error` on an unhandled call).
- `./singularity check` (boundaries, type-check) is green. The main app's behaviour is unchanged: the seams are no-ops on Bun.

## Out of scope / follow-ups (next main task carries them)

- Writes through real handlers plus the change feed over `pglite.listen`.
- Moving the stubs and the pack into the worker as seed, then deleting the page server.
- The `liveValue` unavailability arm.
- Demo state persistence (memory or IndexedDB with a reset).
- A composition-generated worker registry.
- Bundle size.

## Risks

- **`AsyncLocalStorage`** (tasks-core, change-feed producer) under `unenv` may not propagate across awaits. The spike checks it. If it breaks, it needs a real browser implementation (single realm, single connection) rather than a silent degrade.
- **PGlite PG17 vs PG18:** the risk is low (plpgsql only, no PG18 syntax), and the spike's migration run proves it either way.
- **Module-evaluation side effects** in fat closures: step 1 measures them before anything else is built.
