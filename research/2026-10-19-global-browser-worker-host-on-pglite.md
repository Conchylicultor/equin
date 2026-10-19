# Browser worker host: the portable server graph on PGlite answers the demo's task categories

Track: "Demos and client server" (`block-3e397e42-…`) → "Track: apps running in the browser"
(`block-d04c6c0d-…`) → subtrack "portable server code (server/ vs machine/)" (`block-323b766d-…`),
task row "[Slice] Browser worker host on PGlite answering the demo's task categories from seed rows".
Earlier plans: `2026-10-18-global-browser-server-real-server-code-on-pglite.md` (its worker, PGlite,
seed and page-side parts still apply; its platform shims are superseded) and
`2026-10-18-global-portable-server-machine-split.md` (the framework this builds on).

## As built (2026-10-19) — where the implementation departs from the design below

- **No worker-host sub-plugin.** `bootBrowserHost` lives in `server-core/core/browser-host.ts`
  (a third composition root beside `bin/index.ts` and `exec`); the port protocol
  (`serveOverPort` / `portBrowserServer`), `runtimeBrowserServer` and `composeBrowserServers` are in
  `framework/browser-server/core`.
- **The build is a web-artifacts stage, not `tooling/browser-hosts`.** A plugin's
  `bin/browser-host.ts` is built by vite's worker pipeline (through a `new Worker(new URL(…))` stub, so
  the page preload helper never enters the worker) into one content-addressed store artifact, mapped
  as `@browser-host/<pluginPath>`; its address is the recorded set of modules the last build loaded
  (`web-artifacts/core/internal/browser-hosts.ts`). A repo module importing a Node builtin fails it.
- **No `entryClosure`.** The graph is declared as a plugin list (`bin/browser-host.plugins.ts`);
  codegen (`browser-host-gen.ts`) unions the server barrels the import closure of those plugins reaches
  (`importClosure`, dynamic imports cut) into `bin/browser-host.generated.ts` — 45 entries. A
  `dependsOn` closure pulled non-portable barrels; the import closure does not.
- **Category contributors: deploy, home, prototypes** (already 0-offender closures; flagged
  `portable: true`) instead of splitting `improve`. The boot asserts every booted plugin declares
  `portable` (31 barrels flagged).
- **Runtime hazards fixed in place**: `Buffer.byteLength` → `utf8ByteLength` (query-resource) or
  `TextEncoder`, base64 via `btoa`, `process.memoryUsage` behind `installHeapReader`. The
  portable-closure check now also reports platform globals (`Buffer.`, `process.`, `Bun.`, …).
- **No L2 in the browser**: `captureWatermark` resolves `undefined` in `browser` mode (tokenless
  frames, like central). Plugin `wsRoutes` are not served by a browser host.
- **Composition precedence**: the page server (pack + Demo.Resource) owns every key it serves; the
  worker owns the rest of its keys; the page server is the fallback. The worker's tasks-core also
  serves `tasks`, but the pack wins it, so the task list still groups from pack rows — moving tasks /
  attempts / conversations into the worker seed is the next slice.
- **Measured**: bundle 18.6 MB (825 repo modules; ~16.7 MB is PGlite's wasm + data); worker boot to
  `ready` (migrations + seed, warm cache) 0.9–1.6 s.

## Context

- **Portable today, but only in Bun.** task-category's whole server closure is portable.
  `tasks/task-category/server/internal/portable-boot.test.ts` proves it in Bun:
  - it boots `closureOf("tasks/plugins/task-category")` plus five portable providers through
    `bootPluginGraph({ mode: "exec" })` on in-memory PGlite;
  - it runs the real migrations (read from disk by a hand-built `MigrationSource` entry);
  - it reads seeded rows with `loadResourceByKey("task-categories")`.
- **The demo answers nothing for these keys.** `/demo` (`DemoScope` → `createBrowserServer`)
  answers only from the recorded pack plus the `Demo.Resource` stubs. Nothing serves
  `task-categories` or `task-category.registry`, so both fail with `DemoMissingError`, and the task
  list has no category sections.

**Outcome:** a Web Worker, built from the real plugin server code, boots that same graph on PGlite in
the page. It runs migrations from bundled text and answers `task-categories` and
`task-category.registry` for `/demo` from seed rows. The pack and the stubs keep answering everything
else, through a key-routed composition of the two servers. Nothing in the desktop app changes.

## What the exploration found (constraints the design answers)

1. **The web build can't produce this worker as is.** web-artifacts' rule is "a worker is bundled
   whole, from its own plugin only", and its inline audit hard-fails otherwise. A server host is
   inherently a whole-graph bundle, like the Bun server. So it needs its own build stage, not a
   nested vite worker.
2. **The generated `serverEntries` names all 394 server barrels.** It uses dynamic imports, so
   bundling it would try to compile pg, graphile and the rest. The worker needs an entry list limited
   to its own closure.
3. **The closure has run-time platform hazards that the import-based portable check can't see.**
   - `server-core/core/resources.ts:381` reads `process.env.NODE_ENV` at module scope.
   - `core/profiler.ts` calls `process.memoryUsage()` during boot (`recordMemoryCheckpoint`).
   - Others may exist, which is why step 1 is a spike.
4. **No `MigrationSource` provider reads bundled text yet.** The test builds one inline from files on
   disk.
5. **`bin/` may import server barrels, but it is allowed platform APIs.** A worker entry there is not
   lint-protected, so the build itself must assert the bundle is portable.
6. **The category registry is built from `TaskCategory` contributions in other plugins' `server/`
   barrels** (improve, build, backup, deploy, …), and none of them is portable yet. A host's registry
   is exactly its booted plugins' contributions, which is the right semantics. So the demo shows the
   categories of the contributor plugins it boots, and each one booted must be portable.
7. **Every protocol frame names its `key`.** The client frames are `sub`, `sub-batch` entries,
   `unsub` and `sub-acks`; the server frames are `sub-ack`, `update`, `delta`, `invalidate`, `ack`
   and `sub-error`. So two servers can share one transport, routed by key, without touching the
   live-state client.

## Design

### 1. The worker host (new sub-plugin `framework/browser-server/plugins/worker-host`)

- **Worker side (`core`, DOM-free).**
  - `startWorkerHost({ entries, seed })` boots `bootPluginGraph` in a new **`browser` mode**
    (`server-core/core/boot-mode.ts`). This mode is `exec` plus the serving pieces: it skips QoS,
    signals, `markServerReady` and the socket bind, and runs `onReady`.
  - It passes `hasCoreBarrel: () => false`, as release builds do.
  - It asserts that every booted plugin declares `portable: true`.
  - It runs `seed(db)` after the ready barrier, then serves over the worker's `self`.
  - It posts `{ type: "ready", keys, timings }`, where `keys` is the set of resource keys its runtime
    defines, or `{ type: "failed", error }`. A boot failure is loud on the page and is never an empty
    answer.
- **One route table, two hosts.** `populateRoutes` moves out of `server-core/bin/index.ts` into
  `server-core/core` as `collectHostRoutes(ordered)`. It returns the `createRequestHandler` over the
  plugin `httpRoutes` plus `RESOURCE_HTTP_ROUTE`, and the ws routes. Both `bin/index.ts` and the
  worker host use it.
- **Port protocol (`framework/browser-server/core`).** One shared, typed message vocabulary:
  - `request` / `response`: a serialized Request and Response, with method, url, headers and a text
    body;
  - `socket-open` / `socket-frame` / `socket-close`, keyed by a connection id.
  - Worker side, `serveOverPort(port, { request, ws })` maps these onto the router and
    `notificationsWsHandler` (with a `RuntimeSocket` per connection, as `createBrowserServer` does).
- **Page side (`framework/browser-server/web`).** `workerBrowserServer(worker): Promise<BrowserServer>`
  implements the existing `BrowserServer` interface (`request`, `connect`, `dispose`) over that
  protocol. It resolves on `ready` and rejects on `failed`. `browserServerTransport` and every app
  call path are unchanged.

### 2. Two servers, one transport: `composeBrowserServers` (browser-server/core)

- **API.** `composeBrowserServers([{ server, keys }, …], fallback): BrowserServer`.
  - A key is owned by the first server whose `keys` holds it; every other key goes to `fallback`.
  - This is a generic primitive; the demo is just its first user.
- **HTTP.** `/api/resources/:key` goes to the key's owner. Any other route goes to `fallback` first,
  and its `onUnmatched` forwards to the others. Endpoint routes are not used by this slice, but this
  keeps them correct.
- **Socket.** One composite socket opens a socket on each server.
  - Client frames are routed by `key`. A `sub-batch` is split per owner, each part with its own
    `complete` flag. `unsub-tab` is broadcast.
  - Server frames from every server merge into the one peer. Pings are taken from the fallback only.
  - Epochs differ per server, which costs at most a full reload on replay. That is safe, because a
    server only answers `up-to-date` under its own epoch.
- **Transitional.** It goes away when the pack and the stubs move into the worker as seed data (the
  track's "[Demo] The pack becomes seed data" task). It is still useful later, for example to put a
  page-side and a worker-side server under one transport.

### 3. Building the worker (new build stage `tooling/browser-hosts`)

- **Declaration.** A plugin declares a host in `bin/browser-host.ts`, which has two parts:
  - `export const plugins = [...] as const`: plain data, the host's root plugin paths (roots plus
    providers). The build imports it in Bun.
  - `export default startWorkerHost({ entries: hostEntries, seed })`: the worker entry.
    `hostEntries` comes from a generated module.
- **Generated entries.** The stage writes `bin/browser-host.generated.ts`, committed and kept in
  sync by `plugins-registry-in-sync`, like the other registries.
  - It holds the `dependsOn` closure of `plugins` over the server registry metadata, through
    `entryClosure(entries, roots)`. That function is extracted from the test's `closureOf` into
    `server-core/core`, so the test and the build share it.
  - Its loaders are `() => import("@plugins/<p>/server")`, so the bundle reaches only those barrels.
- **Bundle.** `vite build` (lib mode, `format: "es"`, `target: "esnext"`) of the host entry.
  - `define` sets `process.env.NODE_ENV`.
  - PGlite's `.wasm` and `.data` are emitted as assets through its own
    `new URL(…, import.meta.url)`.
  - No externals, because import maps don't reach workers.
- **Portability gate.** The build fails if the bundle's closure reaches a platform module (the same
  matcher as `boundaries:portable-closure`, through `importClosure`) or a non-portable plugin. It also
  fails on vite's "externalized for browser compatibility" warnings.
- **Content-addressed.** The address hashes the closure's files (from `importClosure`), the lockfile
  and the build config. The output goes into the web-artifacts store, and compose links it into
  `dist/`.
- **The URL reaches the page through the import map.** Compose maps the bare specifier
  `@browser-host/<plugin-path>` to the worker file, so the graph hash covers the worker. The page does
  `new Worker(import.meta.resolve("@browser-host/<p>"), { type: "module" })`, and an unmapped host
  throws at resolve.
- **Composition-aware.** A host is built only when its plugin is in the composition fleet.
- **The bundle size is logged.**

### 4. Migrations from bundled text (new `database/plugins/migrations/plugins/bundled-source`)

- `server/` (portable) provides `MigrationSource` from
  `import.meta.glob("../../../data/*.sql", { query: "?raw", eager: true })` through the existing
  `migrationsFrom`. It is booted only by worker hosts.
- The Bun test keeps its disk source. Bun has no `import.meta.glob`, and that is fine: the harness
  isn't under test.

### 5. The demo host and its seed (`apps/agent-manager/plugins/demo/bin/browser-host.ts`)

- **`plugins`:** `tasks/plugins/task-category`, the providers (`database/plugins/pglite`,
  `jobs/plugins/in-process`, `attachments/plugins/memory-blobs`,
  `log-channels/plugins/memory-persistence`, `tasks-core/plugins/seeded-push-ledger`,
  `migrations/plugins/bundled-source`), and the category contributors chosen in the spike.
- **`seed(db)`:** inserts, through the real drizzle tables, the pack's `task-demo-*` tasks (the same
  ids, imported from the demo's `core` pack data) plus a `tasks_ext_category` row for each.
  - The categories come from the booted contributors.
  - The pack still serves the task rows themselves this session. Both describe the same ids, so the
    category grouping lines up.
- **Scenario wiring.**
  - `DemoScenario` gains `host?: string`, the host plugin path.
  - `DemoScope` starts the worker (`workerBrowserServer`), shows a loading state while it boots (the
    not-known-yet rule), and composes `[{ server: worker, keys }]` with the page server as fallback.
    It terminates the worker on unmount.
  - With no host in a scenario, nothing changes.
- **Category contributors.** The plan is to make `improve` (its `TaskCategory` contribution) portable,
  and one more if it is cheap.
  - Each contributor is run through `portable-closure`.
  - A contributor that is not cheap stays out, and its seeded tasks land in "None". The registry then
    honestly lists only the booted contributions.

## Execution order (stop and report if a step blows up)

1. **Spike: build and boot.**
   - Hand-write the entries for the closure, bundle them with vite, and load the bundle in a headless
     page (`browser_*` tools).
   - List everything that throws at evaluation or boot (`process.*`, `Bun.*`, other globals).
   - Fix each one in place with a host-installed seam, as was done for `installSnapHash` and the
     memory probe. Then `process` is never touched in portable code; a lint for that is a follow-up.
   - If more than about 10 fixes are needed, stop and re-plan.
2. **Server-side pieces:** the `browser` boot mode, `collectHostRoutes` (with `bin/index.ts` switched
   over), `entryClosure` (with the test switched over), the port protocol plus `serveOverPort`,
   `startWorkerHost`, and the bundled `MigrationSource`.
3. **Page side:** `workerBrowserServer` and `composeBrowserServers`, each with jsdom/unit tests: an
   in-process fake port, `sub-batch` splitting, and frame merging.
4. **The build stage:** `tooling/browser-hosts`, the generated entries, the portability gate, the
   store, and compose's import-map entry.
5. **The demo host:** its `plugins`, the seed, the contributor split(s), `DemoScenario.host`, and the
   DemoScope wiring.
6. **Close-out:**
   - `./singularity check` and `./singularity build`, then the verification below.
   - Update the subtrack card (tick the row, status, measurements: bundle size, boot timings) and the
     track card.
   - File the next main task (pack and stubs to seed in the worker, then delete the page server and
     `composeBrowserServers`'s demo use), with the subtrack page id and the track-instructions id.

## Critical files

- `plugins/framework/plugins/server-core/core/{boot-stages.ts,boot-mode.ts,resources.ts,profiler.ts}`,
  `bin/index.ts` (route collection out), and the new `core` `collectHostRoutes` and `entryClosure`.
- `plugins/framework/plugins/browser-server/core/internal/` (port protocol, `composeBrowserServers`),
  `web/` (`workerBrowserServer`), and the new `plugins/worker-host/`.
- `plugins/framework/plugins/tooling/plugins/web-artifacts/core/internal/{compose,pipeline}.ts`
  (import-map entry, store) and the new `tooling/plugins/browser-hosts/`.
- `plugins/database/plugins/migrations/plugins/bundled-source/` (new).
- `plugins/framework/plugins/browser-server/plugins/demo/{core,plugins/scope/web/components/demo-scope.tsx}`.
- `plugins/apps/plugins/agent-manager/plugins/demo/{core,bin}`.
- `plugins/tasks/plugins/task-category/server/internal/portable-boot.test.ts` (uses `entryClosure`).
- A contributor split, for example `plugins/improve/{server,machine}`.

## Verification

- **Tests:** `./singularity test` on server-core (`entryClosure`, `browser` mode), browser-server
  (port protocol round trip, composite routing and splitting), task-category (the PGlite boot test is
  still green) and migrations/bundled-source.
- **Build:** `./singularity build` logs the worker bundle size and its address. It fails if a
  non-portable plugin is added to the host's `plugins`, which is worth checking once by hand.
- **In the browser,** open `http://<worktree>.localhost:9000/demo` (with the `browser_*` tools and a
  screenshot):
  - The task list shows category sections with the seeded tasks.
  - The worker's console logs the boot timings: migrations, schema layer, seed.
  - No request leaves the page for `task-categories`.
  - The other demo reads (conversation, transcript) still render from the pack.
- **E2E:** `apps/agent-manager/plugins/demo/e2e/real-server.ts` asserts the category sections render
  in `/demo`.
- **The desktop app is unchanged:** the same boot logs, and the task list grouped by category on
  `http://<worktree>.localhost:9000`.

## Out of scope (next main task)

- Writes through real handlers and the change feed over `pglite.listen`.
- The pack and the stubs as worker seed; deleting the page server.
- The config_v2 split.
- Demo persistence (IndexedDB with a reset).
- Composition-generated host plugin lists.
- Bundle-size work.
- A lint banning `process` and `Bun` globals in portable folders.
