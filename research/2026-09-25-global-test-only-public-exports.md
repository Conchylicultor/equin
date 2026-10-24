# Test-only exports leave public barrels, and a check keeps them out

Design: Plugin system page, block `block-956d1f2d-572c-4769-8596-eeb747307929`
(the "test code is its own dimension" note).

## Context

A plugin's public barrel (`<runtime>/index.ts`) is its API for other plugins.
Test harnesses were published there, so they looked like API, and shipping
code could import them.

Most of the move already landed on 2026-09-23:

- a11350cde: `createTestDb`, `worktreeDbScenario`, the black-hole proxy,
  networking's fake transports, the hooktheory fixtures, pane's `TestSurface`
  and the deploy dashboard fixtures moved into `<runtime>/testing/` barrels.
  Plugin-boundaries rule R12 now fails a public barrel that exports a
  `*ForTest(s)` name, or takes names from a test-support file.
- 9bf0c82ca and 5eb4d171c: the docs and build tools treat `testing/` as test
  code, and the docs list the testing barrels.

Current state (measured):

- No helper without a `.test` suffix remains under a `__tests__/` directory.
- `db-test-fixture/server/index.ts` exports nothing now. It stays registered
  only as an empty plugin definition. The sweep job is its own child plugin.
- test-layout's `core/index.ts` still exports `FAKE_DOM_GLOBALS`,
  `fakeDomInstalls` and `FakeDomInstall`. Nothing imports them through the
  barrel: the check next to them imports `../core/fake-dom` directly.

What's missing is the measurable guard. R12 only recognizes a test helper
by its name. The signal the user asked for is who imports the export: a
public export whose only importers are test files. A precise scan (TypeScript
parser, named imports only) finds **95** such exports today:

- **39: the plugin's own tests import it through its public barrel.** For
  example, sonata theory's `detect.test.ts` imports `detectChord` from
  `@plugins/…/theory/core`.
- **56: a test in another plugin imports it.** No shipping code in the
  importing plugin needs it.

(An earlier text-based scan reported 125. Its extra rows were artifacts:
`import type * as` combined with a `vi.mock` of live-state, and import lines
inside a code string in a test fixture. Its per-row "production users" were
also unreliable.)

### Why the 56 cross-plugin cases are fishy

None of them is plugin A's shipping code needing something inside plugin B.
Each is plugin B making a name public so another plugin's **test** can use it.
They fall into four groups, and each group has a structural fix:

| Group | Examples | Fix |
|---|---|---|
| **Test setup** (install, seed, drive a transport) | `installQueueSchema` (jobs), `ensureChangelogTable` (change-feed), `noteResourceWatermark` / `noteResourceTxAcks` (live-state), `defaultStore` / `PaneStoreContext` (pane), `lintToolkit` (lint), `loadTreeSnapshot` / `computeTreeHash` / `validate` / `ReadSet` (checks), `runStatusBatchOn` (tasks-core), `untrashBlocks` (editor), `createIpCountryLookup` / `buildSnapshot` / `IpCountryLookup` (ip-country) | Move to the owner's `<runtime>/testing/` barrel |
| **The owner's contract, checked from the contributor** | mail's `data-exclusions.test.ts` calls `planBackupExclusions` / `planForkExclusions` in database/admin to check mail's own tables | The owner publishes one contract assertion from `server/testing` (e.g. `expectExclusionsClosed(tables, contributions)`). The contributor's test calls that, not the planner internals. |
| **A's test checks A against B's real contract** | `live-state/web/keyed-diff-roundtrip.test.ts` round-trips resource-runtime's `buildSnapshot` / `diffKeyed*` against live-state's merge (live-state is downstream, so the test must stay there); `element-picker`'s `portal-lineage.test.tsx` uses ui-context's `parseLineage` | The test stays. B publishes the names it needs from `<runtime>/testing/` (a testing barrel may re-export a real function). Move a test only when it tests nothing of its own plugin. |
| **B's constant, type or error, read to build a fixture or check a result** | `PITCH_LAYOUT_LABELS`, `RUN_*_SUFFIX`, `WORKTREE_SPEC_FILE`, `QueryDeadlineExceededError`, `SqlColumnError`, `RecurrenceRule`, `SlotMeta`, `NavigationType`, `ReorderNodeData`, `ceilingMsFor`, `useActiveDataLinkify`, `FileLinkText` | Reach it through A's own API if A has one. If not, B publishes it from `<runtime>/testing/`. Delete the barrel entry when nothing ships with it. |

Several of these are between a parent plugin and its child (`apps-core` ←
`tabs`, `checks` ← `plugin-boundaries`, `ui-context` ← `element-picker`). A
child is a separate plugin, so the same fixes apply.

## Decisions

- **Own-plugin test importers count** (user's answer). A plugin's own tests
  import its internal files by relative path. The public barrel exists for
  other plugins. Fixing these 39 needs only the test's import to change. Whether
  the export stays public is decided on its own merits; if its only use was that
  test, it leaves the barrel.
- **No exceptions list.** Every case found has a structural fix, so the check
  has no allowlist. A legitimately test-only public name has a place to go:
  the testing barrel.
- **`check/` and `lint/` importers count as shipping code.** A check may use a
  public API; 90 exports are used only by `check/` or `lint/` code, and those are
  out of scope.
- **Exports nothing imports** are out of scope. That is a dead-code question,
  not a test-leak question, and it has ~2.9k candidates.

## Implementation

### 1. New rule in plugin-boundaries: `test-only-public-export` (R13)

File: `plugins/framework/plugins/tooling/plugins/checks/plugins/plugin-boundaries/check/`
— new `test-only-exports.ts` + `test-only-exports.test.ts`, wired in `index.ts`
next to R12 (`test-exports.ts`).

- **Data collection rides the existing file loop** in `index.ts` (~line 257).
  That loop already reads every source file via `selectSourceFiles`, so the
  input-keyed cache/read-set stays correct with no new enumeration. For
  each file, `findImports(src)` (parse-utils) gives the specifier and a masked
  clause. Resolve the specifier to a public barrel (an `@plugins/…/<runtime>`
  specifier, or a relative path landing on `<runtime>/index`), excluding `…/testing`.
  Record per (barrel, name) whether any importer is non-test code
  (`isTestCodePath` from plugin-id core).
  - Named bindings → `parseBindingList` (`./parse.ts`), using the original
    name (`a as b` → `a`). `export { x } from` counts as a use of `x`.
  - A value namespace import (`import * as X`) from non-test code marks every
    name in that barrel as used. A type-only namespace import from a test
    (the `vi.mock(importOriginal)` idiom) marks nothing.
- **Barrel names**: split each public barrel with `splitTopLevelStatements` and
  read its names with `exportedNames` (export it from `test-exports.ts` instead
  of copying it). Skip the default export.
- **Violation**: a name with ≥1 importer, all of them test code. The message
  names the barrel, the name and up to 3 test importers. The fix text says what
  to do in each case: an own-plugin test imports the internal file by relative
  path; a helper moves to `<runtime>/testing/`; a test of another plugin's code
  moves into that plugin.
- Unit tests: a named import, an aliased import, a type-only namespace import
  in a test (not a use), a value namespace import in shipping code (a use of
  every name), a relative import of the own barrel from a test, `export … from`
  as a use, and a `testing/` importer counting as test code.

The rule reports using the rule id and push-back hint R12 already uses.
Keep the logic in a pure function, `(barrels, uses) → Violation[]`, so the
unit test needs no repo.

### 2. Fix the 95 current violations

Work through the check's own output, group by group, using the table above:

- **Own plugin (39)**: change each test to a relative import of the internal
  file. Then any name nothing else uses leaves the barrel. Examples:
  `sonata/theory/core/detect.test.ts`, `pane/web/__tests__/{optional-param,
  history-sink,deep-link-load-gap}.test.tsx`, `avatar/web/__tests__/avatar.test.tsx`,
  `css/layout-harness/web/internal/layout-geometry.test.ts`.
  `db-test-fixture/server/testing/create-test-db.ts` → `mintTestDbName`: the
  testing file imports `../../core/...` relatively.
- **Test setup (cross-plugin)**: create or extend `<runtime>/testing/index.ts`
  in jobs/server, change-feed/server, live-state/web, pane/web, tooling/lint/core,
  tooling/checks/core, tasks-core/server, page/editor/server,
  deploy/analytics/ip-country/server. The helper's body stays next to its
  state, and the testing barrel re-exports it. That's the pattern a11350cde
  used for the reset hooks. Remove the name from the public barrel.
- **Contract assertion**: database/admin gets `server/testing` with an
  exclusion-closure assertion built from its own planner. mail's
  `data-exclusions.test.ts` calls it. `planBackupExclusions` /
  `planForkExclusions` / `SchemaCatalog` / `CatalogForeignKey` leave the
  public barrel unless shipping code imports them.
- **Test in the wrong plugin**: move `keyed-diff-roundtrip.test.ts` into
  resource-runtime, the plugin-refs scanner cases into plugin-refs, and the
  `parseLineage` cases into ui-context.
- **Constants / types / errors**: decide per row, following the table's rule.
  Each change is a line in a barrel plus the test's import.
- test-layout `core/index.ts`: drop the three fake-dom exports. Nothing imports
  them through the barrel; the check keeps its relative import.

After this, `./equin check plugin-boundaries` must report 0 R13
violations. `./equin build` regenerates `docs/plugins-*.md` and the
per-plugin CLAUDE.md autogen blocks, and the moved names now show up under
*Test helpers*.

### 3. Docs

- `plugins/framework/plugins/tooling/plugins/boundaries/CLAUDE.md` ("Test
  code") and the plugin-boundaries CLAUDE.md: one paragraph on R13, covering
  the signal and the three fixes.
- Root `CLAUDE.md`, the *Test code* bullet: add "a public export only tests
  import is a violation (R13)".

## Verification

1. `./equin test plugins/framework/plugins/tooling/plugins/checks/plugins/plugin-boundaries`
   runs the new unit tests.
2. Before step 2, `./equin check plugin-boundaries` reports 95 R13
   violations, the same set as the scratch scan. After step 2 it reports 0.
3. Re-introduce one leak by hand (export a helper from `jobs/server` and
   import it only from a test) and confirm R13 fails. Then revert it.
4. `./equin test` on every plugin touched by a moved test or changed
   import. Moved tests must pass in their new plugin.
5. `./equin build` (in the background) runs the full check suite,
   including `plugins-doc-in-sync`, `type-check` and `eslint`, and deploys
   cleanly.
