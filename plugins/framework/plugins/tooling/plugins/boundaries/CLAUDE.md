# boundaries

`core/boundary-config.ts`'s `folders` table is the single source for what a
plugin folder may import. **Derive from it; never restate a slice of it as a
literal.** `core/runtimes.ts` holds `runtimeNames`, the folder names a
`@plugins/<p>/<folder>` specifier may end in (the barrel folders).

## Folders

The folder vocabulary lives in `plugin-id/core`: `RUNTIME_FOLDERS` (barrels:
`web`, `server`, `core`, …) and `LEAF_FOLDERS` (`check`, `lint`, `facet`, `bin`,
`scripts`, `exhibits`, `vite`, `prewarm`, `python`), together `PLUGIN_FOLDERS`. Plus
`plugins/`, which holds child plugins, not code.

- **Every folder has a row.** The table is `Record<PluginFolder, RuntimeFolder[]>`,
  so a folder name added to the vocabulary is a tsc error until it declares what
  it may import. `defineCollectedDir` takes a `PluginFolder`, and codegen's
  discovery throws on a name outside the vocabulary.
- **A leaf is never a target.** Row values are `RuntimeFolder`s, so no row can
  list `check`, `lint`, `bin`, …. `runtimeNames` derives from `RUNTIME_FOLDERS`,
  not from the table's keys, so `@plugins/x/check` is not a legal specifier.
- **A file with no folder is a violation.** A loose file at a plugin root, a
  folder outside the vocabulary, or a file under `plugins/` that no child plugin
  claims is reported, and so is an import that lands on one. Adding a new kind of
  folder is one edit to `LEAF_FOLDERS` (or `RUNTIME_FOLDERS`), then its row.

## Test code

Test code is a second dimension beside the folder, defined once by
`isTestCodePath` in `plugin-id/core`: a `*.test.ts(x)` file, or anything under
`__tests__/` or `testing/`.

- **It follows its folder's row.** A helper in `server/testing/` gets the
  `server` row. No row mentions test code. So the runtime a testing barrel sits
  under is chosen by who must reach it: `web/testing/` is reachable only from
  web tests, `server/testing/` only from server-side ones, and a helper that
  both web and server tests use goes in `core/testing/` (every row reaches
  `core`).
- **Only code that verifies may import it.** That is test code itself plus
  `VERIFYING_FOLDERS` (`check/`). Everything else ships — `e2e/` included, since
  it drives the running app rather than importing code — and importing test
  code is a violation, even from the same folder. `judgeImport`
  (`core/evaluate.ts`) asks this before the own-folder exemption.
- **`testing/` sits directly under a runtime folder, never under `e2e/`.**
  Anywhere else it is reported (`misplaced-testing`). That keeps the name
  unambiguous, so walkers (`parse-utils`' `walkFiles`) skip it by name, which
  keeps a harness's imports out of a plugin's docs and composition closure.
- `@plugins/<p>/<runtime>/testing` is the one legal import ending beyond the
  barrel (plugin-boundaries R4), and the testing barrel is held to R3 like any
  barrel.
- The other direction: a public barrel publishes no test support
  (plugin-boundaries R12). Examples of the pattern: `createTestDb`
  (`database/db-test-fixture/server/testing`), the fake transports
  (`primitives/networking/web/testing`), `TestSurface`
  (`primitives/pane/web/testing`), `loadBlockHandles`
  (`page/editor/core/testing`).
- And a public barrel exports nothing that only tests import
  (plugin-boundaries R13). R12 judges a name by its spelling; R13 judges it by
  who imports it. If every importer is test code, the name is not API. Your own
  plugin's test imports the internal file by relative path; a helper moves to
  `<runtime>/testing/`; another plugin's test of this plugin's code moves into
  this plugin. `check/` and `lint/` importers count as shipping code.

## One table, inside and across plugins

`boundary-rules` resolves every import it reads — `@plugins/…` and relative
(`./x`, `../server/y`) alike — to a plugin and a folder, then applies the same
`folders` row whether or not the target is in the same plugin. So `core/`
importing its own `../server/x` fails exactly like `core/` importing
`@plugins/other/server`. Only the zone edges (`allow`/`deny`) and the cycle
graph stay cross-plugin: they say which plugins may depend on each other.

Two things differ inside a plugin, and `checks/plugin-boundaries` owns both:
`shared/` is reachable only from its own plugin, and deep paths are allowed
only there.

## Which files `boundary-rules` reads

Git decides what exists (`listRepoFiles`, the cache key's universe). The zones
decide what is in scope (`zoneMap.resolveFile`). Don't add a source-root list or
a directory deny-list beside them. A second statement drifts. The last one
hid the tracked `build` plugins while still scanning gitignored `.cache/` files.

## Platform APIs and host-only values

`core/platform-apis.ts` is the one definition of what needs the computer. Two
readings use it:

- `isPlatformApi(specifier)`: an import of a Node builtin, `bun`, `pg`,
  graphile, a native watcher. Read per file by the `boundaries/no-platform-api`
  lint (forbidden folders), and per closure module by the server-portability
  derivation (below).
- `platformValueUsesIn(ts, fileName, source)`: the host-only VALUES a module
  uses, which no import names. That covers a platform global read as a value
  (`Buffer.from`, `z.instanceof(Buffer)`, `opts.defer ?? setImmediate`,
  `process.*`, `Bun.*`, Bun's `HTMLRewriter`, …), Bun's module-path
  `import.meta` properties (`.dir`, `.dirname`, `.filename`, `.path`,
  `.require`, `.main` — undefined in a browser realm; `.url` / `.env` are
  fine) and an unguarded `.unref()` (a browser timer is a number). It is a TypeScript AST pass, so strings, comments, type positions,
  keys (`{ setImmediate: f } = globalThis`), `typeof` probes, local shadows,
  `process.env.NODE_ENV` and the guarded `.unref?.()` never count. The caller
  passes the `typescript` module (import-closure's `loadTypescript`), so the
  file stays import-free for jiti. It binds only what a portable closure
  loads (the derivation below). The per-file lint does not read it, because a
  non-portable `server/` file may use `process` freely.

## Server portability is derived (`core/portability.ts`)

Whether a server barrel can run on a host without the computer (a page's
worker) is a fact of its static import closure, never a flag a plugin writes.
`serverPortabilityOf(repo)` answers it for every `server/index.ts` at once:
ONE `importClosures` build over all of them (dynamic imports cut), then a
reverse BFS over the reversed edges (`UnionImportClosure.children`) from the
modules that need the computer. A module needs it when it:

1. imports a platform API at runtime (`isPlatformApi`; `import type` and an
   all-`type` binding list erase — `loadsAtRuntime`);
2. uses a host-only value (`platformValueUsesIn`, run only on a module whose
   text names a platform global or `unref` — `mayUsePlatformValue`);
3. declares a host service no portable `server/` barrel provides — a
   computer-only API behind a seam. Whether a provider is portable depends on
   the same taint, so this is a monotone fixpoint (taint, then the declarers
   of services left without an untainted provider, re-propagate, until
   stable). A `server/` barrel that provides a service is a host provider,
   which no composition bundles (`EdgeGraph.hostProviders`), so the portable
   providers are exactly a browser host's candidates.

`offenders(barrel)` explains a non-portable barrel: the frontier modules that
need the computer (one per plugin outside its own), each with what it needs and
the shortest chain from the barrel; never empty. The answer is one shared
promise per `RepoFiles` (a `WeakMap`), so codegen's browser-host derivation,
its coverage guard's messages, `host-services:provider-placement` and
`boundaries:portable-own-barrels` share one build per process. Readers:
the browser host's graph roots and providers (codegen), the coverage guard's
"why not portable" (`serverBarrelBlockers`), provider placement, and the
own-barrel rule below. Pinned by `core/portability.test.ts` (a fixture tree:
cycle, type-only and dynamic imports, a host global, the chain, rule 3).

`boundaries:portable-own-barrels` holds a portable barrel's `server/` files to
importing their own plugin's other folders through the barrel (`../core`,
never `../core/x`): the browser host loads each folder as its barrel artifact.

`scripts/measure-derived-portability.ts` (`./equin run …`) prints the union
build's size and time, the derivation's cost, and the barrels made
non-portable by rule 3 alone.

`boundaries:machine-portable-declaration` reads the same matcher (rules 1 and 2,
`platformOffenders`, per module) the other way
round: a `machine/` module that declares a retention (`defineRetention`,
`markCascadeBounded`) or a warm-up (`defineWarmup`) must have a closure that
reaches a platform API. Those declarations are portable — every host runs
them — so one that needs no computer belongs in `server/`; in `machine/` the
browser host silently drops it. It is read per declaring module, so a machine
half mixing a real platform job with a portable sweep is still caught. The
escape is a `sanctioned` exemption for a declaration desktop-only by policy.

## The browser realm loads nothing host-only (`boundaries:web-loads-portable`)

The `folders` table lets `web/` import `core/` (and its own `shared/`), and
`no-platform-api` keeps those folders free of platform imports — per file, with
`debt` exemptions for host-only `core/` files not yet split. Neither sees a
`web/` file loading such a barrel *transitively*, so `paths/core` (`homedir()`
at module scope, `import.meta.dir`) passed tsc and every boundary check from a
jsdom suite, then crashed at module eval.

`boundaries:web-loads-portable` checks the fact, not the folder label. It
collects every module outside `web/` / `exhibits/` that a browser-realm module
loads at runtime. It measures them as one union closure (`importClosures`,
dynamic imports cut; ~600 entries, a few seconds) and taints it with rules 1
and 2 (`platformTaint`, the same seeds, reverse BFS and frontier offenders as
`derivePortability`). Each tainted one is reported with its loaders and the
chain to what needs the computer. Browser realm =
`web/` + `exhibits/` minus bun:test files (`test-layout`'s `isBunTestPath`:
the `*.test.ts` beside a source runs on Bun); a `web/__tests__/` jsdom suite
is in. So a `core/` file may stay host-only (debt) as long as no browser code
reaches it, and a fix is either splitting the barrel or not importing it. A
`web/` module that never runs in a browser (a Node driver not yet moved out)
takes a `debt` exemption on the check's id.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Boundary-rules checker: zone DSL, edge evaluator, and project boundary config
- Core:
  - Uses: 25 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `framework/plugin-id` ×6
    - `plugin-meta/parse-utils` ×6
    - `framework/tooling/import-closure` ×4
    - `plugin-meta/plugin-records` ×3
    - `framework/tooling/boundaries/runtime-exception.parseRuntimeException`
    - `infra/host-fs/user-path.joinAppPath`
    - `infra/spawn.getWorktreeRoot`
    - `packages/macrotask-yield.yieldMacrotask`
    - `packages/timed-fs.existsSync`
    - `plugin-meta/plugin-tree.buildStructureTreeOnce`
  - Exports (types):
    - `AllowEdge`
    - `BoundaryConfig`
    - `DenyEdge`
    - `Edge`
    - `Offender`
    - `ServerPortability`
    - `ZoneDefinition`
  - Exports (values):
    - `allow`
    - `boundaryRulesCheck`
    - `compositionRoots`
    - `createBoundaryCheck`
    - `defineBoundaries`
    - `deny`
    - `isPlatformApi`
    - `platformValueUsesIn`
    - `runtimeNames`
    - `serverPortabilityOf`
    - `zone`
- Cross-plugin:
  - Imported by:
    - `framework/cli/build`
    - `framework/tooling/codegen`
- Exemptions:
  - Exempts itself from: `boundaries/no-platform-api` — `core/check.ts`, `core/resolve.ts` (debt)
  - Exempted by:
    - `apps/browser/engine` (0 debt)
    - `apps/chord/song-index` (3 debt)
    - `apps/deploy/analytics/collect` (2 debt)
    - `apps/deploy/analytics/ip-country` (2 debt)
    - `apps/deploy/deployments` (1 debt)
    - `apps/deploy/servers` (2 debt)
    - `apps/events/refresh` (2 debt)
    - `apps/events/sources/coworkmeet` (1 debt)
    - `apps/events/sources/dmda` (1 debt)
    - `apps/events/sources/salsanueva` (2 debt)
    - `apps/events/sources/url-extract` (1 debt)
    - `apps/file-explorer/git` (2 debt)
    - `apps/places/place-details` (1 debt)
    - `apps/sonata/transcription` (5 debt)
    - `auth/apple-signing` (1 debt)
    - `backup` (2 debt)
    - `backup/sources/attachments` (1 debt)
    - `backup/sources/claude-settings` (1 debt)
    - `backup/sources/config` (1 debt)
    - `backup/sources/cost-history` (1 debt)
    - `backup/sources/databases` (1 debt)
    - `backup/sources/platform` (1 debt)
    - `backup/sources/project-memory` (1 debt)
    - `backup/sources/prototypes` (1 debt)
    - `backup/sources/secrets` (1 debt)
    - `backup/sources/transcripts` (1 debt)
    - `backup/targets/google-drive` (2 debt)
    - `backup/targets/local` (1 debt)
    - `build/restart-skip` (0 debt)
    - `build/serve-composition` (1 debt)
    - `build/server-build-id` (2 debt)
    - `code-explorer` (5 debt)
    - `config_v2/disk-read` (1 debt)
    - `config_v2/ledger` (1 debt)
    - `conversations` (3 debt)
    - `conversations/conversation-view/code` (2 debt)
    - `conversations/transcript-retention` (1 debt)
    - `conversations/transcript-watcher` (4 debt)
    - `conversations/workspace/scratch` (3 debt)
    - `conversations/workspace/worktree` (1 debt)
    - `database` (1 debt)
    - `database/admin` (4 debt)
    - `database/client-tools` (1 debt)
    - `database/connection` (2 debt)
    - `database/embedded` (1 debt)
    - `database/migrations` (7 debt)
    - `database/pgbouncer` (1 debt)
    - `database/query` (1 debt)
    - `debug/broadcasts` (3 debt)
    - `debug/browser-recordings` (1 debt)
    - `debug/browser-recordings/writer` (1 debt)
    - `debug/health-monitor` (3 debt)
    - `debug/heap-snapshot` (2 debt)
    - `debug/logs` (2 debt)
    - `debug/memory` (3 debt)
    - `debug/paging-probe` (2 debt)
    - `debug/profiling/boot-bench` (3 debt)
    - `debug/profiling/fs-wait` (1 debt)
    - `debug/profiling/op-log/op-store` (2 debt)
    - `debug/profiling/runtime` (1 debt)
    - `debug/scratch-hello` (1 debt)
    - `debug/sentinel` (4 debt)
    - `debug/sentinel/status-file` (3 debt)
    - `debug/timeline` (2 debt)
    - `debug/trace/engine` (1 debt)
    - `debug/worktree-cleanup` (4 debt)
    - `framework/cli` (4 debt)
    - `framework/cli/op-runtime` (1 debt)
    - `framework/cli/release` (1 debt)
    - `framework/cli/test` (1 debt)
    - `framework/tooling` (1 debt)
    - `framework/tooling/boundaries` (2 debt)
    - `framework/tooling/checks` (11 debt)
    - `framework/tooling/checks/type-check` (17 debt)
    - `framework/tooling/codegen` (21 debt)
    - `framework/tooling/codegen/composition-registries` (1 debt)
    - `framework/tooling/collected-dir/discovery` (1 debt)
    - `framework/tooling/format` (5 debt)
    - `framework/tooling/guards` (11 debt)
    - `framework/tooling/import-closure` (1 debt)
    - `framework/tooling/lint` (2 debt)
    - `framework/tooling/web-artifacts` (20 debt)
    - `framework/web-core` (1 debt)
    - `infra/asset-mirror/bundle` (1 debt)
    - `infra/corpus-index` (1 debt)
    - `infra/deps/mise` (2 debt)
    - `infra/deps/npm` (1 debt)
    - `infra/deps/playwright-browser` (1 debt)
    - `infra/deps/python/uv-updater` (1 debt)
    - `infra/deps/rust/cargo-updater` (1 debt)
    - `infra/events-test` (1 debt)
    - `infra/file-sink` (3 debt)
    - `infra/file-watcher` (4 debt)
    - `infra/file-watcher/background-arm` (1 debt)
    - `infra/git/checkout-watch` (1 debt)
    - `infra/git/remotes` (2 debt)
    - `infra/git/tree-lock` (1 debt)
    - `infra/host-fs` (16 debt)
    - `infra/host-fs/image` (1 debt)
    - `infra/host-fs/zip` (1 debt)
    - `infra/host/contention` (1 debt)
    - `infra/host/duress/latch` (1 debt)
    - `infra/host/host-admission` (2 debt)
    - `infra/host/host-read-pool` (1 debt)
    - `infra/jobs` (2 debt)
    - `infra/jobs/supervised-job` (3 debt)
    - `infra/launcher` (2 debt)
    - `infra/mcp/browser` (2 debt)
    - `infra/paths` (11 debt)
    - `infra/request-origin/agent-write-ledger` (1 debt)
    - `infra/runtime-profiler` (1 debt)
    - `infra/safe-fetch` (1 debt)
    - `infra/spawn` (3 debt)
    - `infra/spawn/daemon` (1 debt)
    - `infra/ssh` (2 debt)
    - `infra/stack-sampler` (1 debt)
    - `infra/worktree` (8 debt)
    - `infra/worktree/reclaim` (2 debt)
    - `integrations/google-maps` (2 debt)
    - `integrations/youtube/audio-fetch` (3 debt)
    - `packages/flock` (3 debt)
    - `packages/host-semaphore` (1 debt)
    - `packages/owned-fd` (0 debt)
    - `packages/proc-rusage` (1 debt)
    - `packages/signal-origin` (2 debt)
    - `packages/single-flight` (1 debt)
    - `packages/sleep-clock` (1 debt)
    - `packages/source-digest` (0 debt)
    - `packages/spawn-priority` (3 debt)
    - `packages/thread-cpu-clock` (1 debt)
    - `packages/ticket-line` (1 debt)
    - `packages/timed-fs` (0 debt)
    - `plugin-meta/barrel-import` (2 debt)
    - `plugin-meta/parse-utils` (1 debt)
    - `plugin-meta/plugin-refs` (1 debt)
    - `plugin-meta/plugin-tree` (2 debt)
    - `plugin-meta/plugin-tree/faceted` (2 debt)
    - `plugin-meta/relocate` (3 debt)
    - `plugin-meta/token-usage` (1 debt)
    - `primitives/commit-list` (1 debt)
    - `primitives/css/layout-harness` (3 debt)
    - `primitives/icon-picker` (1 debt)
    - `primitives/log-channels/log-files` (1 debt)
    - `release` (4 debt)
    - `release/bundles` (3 debt)
    - `release/source-checkout` (1 debt)
    - `reports/engine` (1 debt)
    - `reports/outbox` (2 debt)
    - `review/plugin-changes` (1 debt)
    - `stats/cost` (3 debt)
    - `toolchain` (1 debt)
    - `ui/icons/icon-sets` (1 debt)
- Sub-plugins:
  - **`runtime-exception`** — The boundary config's runtimeExceptions entry grammar ("<zone>.<plugin id>.<folder> -> <zone>.<plugin id>.<folder>"): parseRuntimeException splits one into its two sides. A leaf with no imports, so…

<!-- AUTOGENERATED:END -->
