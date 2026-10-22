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
  lint (forbidden folders), and per closure module by
  `boundaries:portable-closure`.
- `platformValueUsesIn(ts, fileName, source)`: the host-only VALUES a module
  uses, which no import names. That covers a platform global read as a value
  (`Buffer.from`, `z.instanceof(Buffer)`, `opts.defer ?? setImmediate`,
  `process.*`, `Bun.*`, …) and an unguarded `.unref()` (a browser timer is a
  number). It is a TypeScript AST pass, so strings, comments, type positions,
  keys (`{ setImmediate: f } = globalThis`), `typeof` probes, local shadows,
  `process.env.NODE_ENV` and the guarded `.unref?.()` never count. The caller
  passes the `typescript` module (import-closure's `loadTypescript`), so the
  file stays import-free for jiti. It binds only what a portable closure
  loads: `boundaries:portable-closure`, and codegen's browser-host blockers.
  The per-file lint does not read it, because a non-portable `server/` file
  may use `process` freely.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Boundary-rules checker: zone DSL, edge evaluator, and project boundary config
- Core:
  - Uses:
    - `framework/plugin-id.isTestCodePath`
    - `framework/plugin-id.PLUGIN_FOLDERS`
    - `framework/plugin-id.PluginFolder`
    - `framework/plugin-id.RUNTIME_FOLDERS`
    - `framework/plugin-id.TESTING_FOLDER`
    - `framework/plugin-id.VERIFYING_FOLDERS`
    - `infra/spawn.getWorktreeRoot`
    - `packages/macrotask-yield.yieldMacrotask`
    - `plugin-meta/parse-utils.findImports`
    - `plugin-meta/plugin-tree.buildStructureTreeOnce`
  - Exports (types):
    - `AllowEdge`
    - `BoundaryConfig`
    - `DenyEdge`
    - `Edge`
    - `ZoneDefinition`
  - Exports (values):
    - `allow`
    - `boundaryRulesCheck`
    - `compositionRoots`
    - `createBoundaryCheck`
    - `defineBoundaries`
    - `deny`
    - `isPlatformApi`
    - `parseRuntimeException`
    - `platformValueUsesIn`
    - `runtimeNames`
    - `zone`
- Cross-plugin:
  - Imported by:
    - `framework/tooling/codegen`
    - `plugin-meta/plugin-refs`
- Exemptions:
  - Exempts itself from: `boundaries/no-platform-api` — `core/check.ts`, `core/resolve.ts` (debt)
  - Exempted by:
    - `apps/chord/song-index` (3 debt)
    - `apps/deploy/analytics/collect` (2 debt)
    - `apps/deploy/analytics/ip-country` (2 debt)
    - `apps/deploy/deployments` (1 debt)
    - `apps/deploy/servers` (2 debt)
    - `apps/desktop/wallpaper` (2 debt)
    - `apps/events/refresh` (2 debt)
    - `apps/events/sources/coworkmeet` (1 debt)
    - `apps/events/sources/dmda` (1 debt)
    - `apps/events/sources/salsanueva` (2 debt)
    - `apps/events/sources/url-extract` (1 debt)
    - `apps/file-explorer/git` (2 debt)
    - `apps/pages/content-search` (1 debt)
    - `apps/places/place-details` (1 debt)
    - `apps/prototypes/files` (13 debt)
    - `apps/prototypes/thumbnails` (3 debt)
    - `apps/sonata/sources/midi` (1 debt)
    - `apps/sonata/sources/midi/folders` (2 debt)
    - `apps/sonata/sources/musicxml` (1 debt)
    - `apps/sonata/sources/ultimate-guitar` (1 debt)
    - `apps/sonata/transcription` (5 debt)
    - `auth/apple-signing` (1 debt)
    - `backup` (2 debt)
    - `backup/sources/attachments` (1 debt)
    - `backup/sources/claude-settings` (1 debt)
    - `backup/sources/config` (1 debt)
    - `backup/sources/cost-history` (1 debt)
    - `backup/sources/databases` (1 debt)
    - `backup/sources/project-memory` (1 debt)
    - `backup/sources/prototypes` (1 debt)
    - `backup/sources/secrets` (1 debt)
    - `backup/sources/singularity-platform` (1 debt)
    - `backup/sources/transcripts` (1 debt)
    - `backup/targets/google-drive` (2 debt)
    - `backup/targets/local` (1 debt)
    - `build/build-logs` (1 debt)
    - `build/build-profiling` (1 debt)
    - `build/run-ledger` (1 debt)
    - `build/serve-composition` (1 debt)
    - `build/server-build-id` (2 debt)
    - `code-explorer` (5 debt)
    - `config_v2/ledger` (1 debt)
    - `conversations` (3 debt)
    - `conversations/compaction-context` (1 debt)
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
    - `database/migrations` (6 debt)
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
    - `debug/profiling/op-log/op-store` (2 debt)
    - `debug/profiling/runtime` (1 debt)
    - `debug/scratch-hello` (1 debt)
    - `debug/sentinel` (4 debt)
    - `debug/sentinel/status-file` (3 debt)
    - `debug/timeline` (2 debt)
    - `debug/trace/engine` (1 debt)
    - `debug/worktree-cleanup` (3 debt)
    - `framework/cli` (4 debt)
    - `framework/cli/op-runtime` (1 debt)
    - `framework/cli/release` (1 debt)
    - `framework/cli/test` (1 debt)
    - `framework/tooling` (1 debt)
    - `framework/tooling/boundaries` (2 debt)
    - `framework/tooling/checks` (11 debt)
    - `framework/tooling/checks/type-check` (15 debt)
    - `framework/tooling/codegen` (28 debt)
    - `framework/tooling/format` (5 debt)
    - `framework/tooling/guards` (10 debt)
    - `framework/tooling/import-closure` (1 debt)
    - `framework/tooling/lint` (2 debt)
    - `framework/tooling/web-artifacts` (15 debt)
    - `framework/web-core` (1 debt)
    - `infra/asset-mirror` (3 debt)
    - `infra/audio-analysis` (4 debt)
    - `infra/corpus-index` (1 debt)
    - `infra/deps/mise` (2 debt)
    - `infra/deps/npm` (2 debt)
    - `infra/deps/playwright-browser` (1 debt)
    - `infra/deps/python/uv-updater` (1 debt)
    - `infra/events-test` (1 debt)
    - `infra/file-sink` (3 debt)
    - `infra/file-watcher` (2 debt)
    - `infra/file-watcher/background-arm` (1 debt)
    - `infra/git/checkout-watch` (1 debt)
    - `infra/git/remotes` (2 debt)
    - `infra/host-account` (1 debt)
    - `infra/host-fs` (16 debt)
    - `infra/host-fs/image` (2 debt)
    - `infra/host-fs/zip` (1 debt)
    - `infra/host/contention` (1 debt)
    - `infra/host/duress/latch` (1 debt)
    - `infra/host/host-admission` (2 debt)
    - `infra/host/host-read-pool` (1 debt)
    - `infra/jobs` (2 debt)
    - `infra/jobs/supervised-job` (3 debt)
    - `infra/launcher` (4 debt)
    - `infra/mcp/browser` (2 debt)
    - `infra/paths` (10 debt)
    - `infra/request-origin/agent-write-ledger` (1 debt)
    - `infra/runtime-profiler` (1 debt)
    - `infra/safe-fetch` (1 debt)
    - `infra/spawn` (3 debt)
    - `infra/spawn/daemon` (1 debt)
    - `infra/ssh` (2 debt)
    - `infra/stack-sampler` (1 debt)
    - `infra/worktree` (6 debt)
    - `infra/worktree/reclaim` (2 debt)
    - `integrations/google-maps` (2 debt)
    - `integrations/youtube/audio-fetch` (3 debt)
    - `packages/flock` (3 debt)
    - `packages/host-semaphore` (1 debt)
    - `packages/signal-origin` (2 debt)
    - `packages/single-flight` (1 debt)
    - `packages/sleep-clock` (1 debt)
    - `packages/spawn-priority` (3 debt)
    - `packages/ticket-line` (1 debt)
    - `plugin-meta/barrel-import` (1 debt)
    - `plugin-meta/parse-utils` (1 debt)
    - `plugin-meta/plugin-refs` (1 debt)
    - `plugin-meta/plugin-tree` (3 debt)
    - `plugin-meta/relocate` (2 debt)
    - `plugin-meta/token-usage` (1 debt)
    - `primitives/commit-list` (1 debt)
    - `primitives/css/layout-harness` (2 debt)
    - `primitives/icon-picker` (1 debt)
    - `primitives/log-channels/log-files` (3 debt)
    - `release` (4 debt)
    - `release/bundles` (5 debt)
    - `release/source-checkout` (1 debt)
    - `reports/engine` (1 debt)
    - `reports/outbox` (2 debt)
    - `review/plugin-changes` (2 debt)
    - `stats/cost` (3 debt)
    - `toolchain` (1 debt)
    - `ui/icons` (1 debt)

<!-- AUTOGENERATED:END -->
