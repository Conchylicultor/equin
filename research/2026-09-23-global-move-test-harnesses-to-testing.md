# Move shared test harnesses into `<runtime>/testing/`

## Context

The boundary rules now know what test code is: `*.test.ts(x)`, `__tests__/`,
and `<runtime>/testing/`, published cross-plugin as
`@plugins/<p>/<runtime>/testing`, importable only by test code and `check/`
(`research/2026-09-23-tooling-boundaries-test-code.md`). That task changed the
rules only. The harnesses themselves still sit in public barrels, in `check/`,
or in `__tests__/`, so:

- production code *could* import a fake WebSocket or a throwaway-DB fixture;
- the generated docs list harness symbols as a plugin's API;
- the generated plugin registry says ~25 plugins `dependsOn`
  `database/db-test-fixture`, only because their test files import it
  (see step 1 — a real leak found while planning).

Goal: every shared harness lives in a `testing/` barrel, the registry stops
counting test imports, and a lint stops new test hooks landing in public barrels.

## What was found

A systematic sweep (every barrel symbol that test files import, and that no
production file uses besides its own definition) plus the known list gives:

| Harness | Now | Moves to |
|---|---|---|
| `createTestDb`, `TestDb`, `CreateTestDbOptions` | `database/db-test-fixture/server` barrel, ~46 test importers | `db-test-fixture/server/testing` |
| `worktreeDbScenario`, `DbExecutor` | `db-test-fixture/plugins/worktree-db/server` barrel | `worktree-db/server/testing` |
| `installTaskDerivedSchema` (installs tasks views on a throwaway DB) | `tasks/tasks-core/server` barrel | `tasks-core/server/testing` |
| `startBlackHoleProxy`, `BlackHoleProxy` (file says "Test support") | `database/connection/server` barrel | `connection/server/testing` (file moves too) |
| `FakeWebSocket`, `FakeWsServer`, `FakeBroadcastChannel(Bus)`, `FakeLockManager`, `createTransportHub`, `HUB_*`, `TabHandle`, `TransportHub`, `FakeWsServerOptions` | `networking/web/test-support.ts`, re-exported by the public barrel; used by live-state's tests | `networking/web/testing/` (file moves) |
| `resetDeferredLoadStateForTests` | `framework/web-sdk/core` barrel | `web-sdk/core/testing` |
| `_setClockForTests`, `_setLatchDirForTests` | `infra/host/duress/latch/server` barrel | `latch/server/testing` |
| `resetRuntimeNamespaceForTest` | `infra/runtime-identity/core` barrel | `runtime-identity/core/testing` |
| `loadBlockHandles` (+ the helpers `check/index.ts` also uses) | `page/editor/check/block-handles.ts` | `page/editor/core/testing/block-handles.ts` |
| `LET_IT_BE_VERSE` etc., `HOOKPAD_SOUND_FIXTURES` | `integrations/hooktheory/core/internal/{fixtures,hookpad-sound.fixtures}.ts`, reached by server tests via `../../core/internal/…` | `hooktheory/core/testing/` |
| `TestSurface`, `createTestSurfaceStore` | `primitives/pane/web/__tests__/surface-fixture.tsx` | `pane/web/testing/` |
| `metrics`, `row`, `report` | `deploy/analytics/dashboard/web/__tests__/fixtures.ts` | `dashboard/web/testing/` |

Deliberately **not** moved:

- `db-test-fixture/core` (`parseTestDbName`, `TEST_DB_TTL_MS`, …): the
  production sweep job reads it.
- `hookpad-sound.fixture-format.ts` (the fixture codec): the generator script
  in `hooktheory/scripts/` writes with it, and `scripts/` may not import
  `testing/`. It stays in `core/internal/`; the test imports it from there.
- `ensureChangelogTable`, `defaultStore`, `defaultHistoryAdapter`,
  `PaneStoreContext`: used by production inside their plugin.
- ~20 pure functions whose only cross-plugin callers are tests
  (`planForkExclusions`, `detectChordWeighted`, `avatarColorClass`, …). They
  are real API, not harnesses.
- `layout-harness`: the harness *is* that plugin's product.
- Note: the task text says markdown-apply's `plan.test.ts` / `touched.test.ts`
  use `loadBlockHandles`. On main (and in worktree att-1789913998-688g, whose
  commit is already merged) they do not; only `editor/check/markdown.test.ts`
  and `editor/check/index.ts` do.

## Plan

### 1. Registry stops counting test imports
`plugins/framework/plugins/tooling/plugins/codegen/core/plugin-registry-gen.ts`
— `tsFilesUnder` feeds both `dependsOn` and the bare-npm vendor set, and skips
only `node_modules`/`plugins`. Make it also drop `isTestCodePath` files
(from `plugin-id/core`, the same predicate `parse-utils`' walker uses). Add a
case to `plugin-registry-gen.test.ts`: a `*.test.ts` and a `testing/` import add
no edge. `./equin build` regenerates `server.generated.ts` (and web/
central) without the test-only edges. Do this first: without it, moving
`createTestDb` to `…/server/testing` still maps back to the plugin and keeps the
edge.

### 2. The moves — one pattern
For each row above:
- Create `<runtime>/testing/index.ts`: plain re-exports of the plugin's own
  files, no logic (held to R3 like any barrel). No default export — it is not a
  plugin runtime.
- When the file is wholly test support (`test-support.ts`,
  `black-hole-proxy.ts`, `create-test-db.ts`, `scenario.ts`,
  `install-derived-schema.ts`, `block-handles.ts`, the fixtures) move it under
  `testing/`. When it is a reset/clock hook on production module state
  (`resetDeferredLoadStateForTests`, `_set*ForTests`,
  `resetRuntimeNamespaceForTest`), keep the function beside the state it
  resets and only move the *export* from the public barrel to `testing/`.
- Delete the export from the public barrel. A barrel left with only its
  default export stays (it still defines the plugin runtime).
- Rewrite importers: cross-plugin → `@plugins/<p>/<runtime>/testing`; same
  plugin → relative `../testing` (or `./testing`).

Per-case notes:
- **db-test-fixture**: ~46 test files, a mechanical specifier rewrite. Also
  update the regex in `database/plugins/migrations/check/imperative-create-table-allowlisted.ts`
  (it matches `…/db-test-fixture/server` in source text), comments in
  `derived-views/core/internal/imperative-tables.ts`, and both plugins'
  `CLAUDE.md`. The `worktree-db` split comment (no jobs dependency) still holds.
- **page/editor**: `check/index.ts` imports `../core/testing` (check/ may);
  `check/markdown.test.ts` moves back to `core/markdown.test.ts`, next to the
  code it tests. Update the `CLAUDE.md` paragraph that names
  `check/block-handles.ts`.
- **hooktheory**: move `fixtures.ts` and `hookpad-sound.fixtures.ts`; point
  `scripts/hookpad-sound-golden.ts --emit-fixtures` at the new output path.
- **networking**: update `networking/CLAUDE.md` and the comments in
  `shared-websocket.ts` / `transport-types.ts` that name `test-support`.
- **pane**: the pane `CLAUDE.md` rule ("mount with `TestSurface` from
  `./surface-fixture`") now points at `@plugins/primitives/plugins/pane/web/testing`,
  so other plugins' jsdom tests can use it too.

### 3. Lint: no test hooks in public barrels
Add rule R12 to `checks/plugins/plugin-boundaries` (it already parses every
barrel for R3). A public runtime barrel (`<runtime>/index.ts`, not
`<runtime>/testing/index.ts`) fails when it:
- exports a name matching `/ForTests?$|ForTesting$/` (covers `_set…ForTests`,
  `reset…ForTest`), or
- re-exports from a module whose file name is `test-support`, `fixture(s)`, or
  `*.fixture(s)`.
The message names the testing barrel to use instead. Unit-test it next to the
other rules (`parse.test.ts` style), and document it in
`plugin-boundaries/CLAUDE.md`.

### 4. Docs
- `boundaries/CLAUDE.md` "Test code": one line listing where the harnesses
  now live, as the examples of the pattern.
- `./equin build` regenerates `docs/plugins-details.md`,
  `plugins-compact.md` and each plugin's autogen block (harness symbols drop
  out of "Exports").

## Verification
- `./equin check plugin-boundaries`, `./equin check boundary-rules`
  and `./equin check type-check` pass; the new R12 fails if an
  `export { resetFooForTests }` is added back to a public barrel (checked by its
  unit test).
- `./equin test` on every touched plugin: db-test-fixture users
  (tasks-core, infra/jobs, change-feed, chord, …), networking, live-state,
  web-sdk, duress, runtime-identity, page/editor, hooktheory, pane, deploy
  dashboard, codegen.
- `server.generated.ts` no longer lists `database/plugins/db-test-fixture` in
  any `dependsOn`, and `rg "db-test-fixture/server\"" plugins` finds nothing.
- `./equin build` (in the background) succeeds: the registry, docs and
  migrations checks are in sync.
