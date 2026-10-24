# Boundary rules learn what test code is

## Context

The boundary checkers treat every file inside a plugin folder the same way. They
have no notion of test code, so:

- nothing stops production code from importing a test file or a test helper;
- a plugin has no way to publish test helpers apart from its public API, so
  shared harnesses end up in `core/` (mixed with the API) or in `check/`, reached
  by a relative path.

The model was agreed on the Plugin system page (card under "I do not like that
test harness is mixed with the public API", block-956d1f2d…). This task is the
rule side only. Moving the existing harnesses (`loadBlockHandles`,
`createTestDb`, the hooktheory fixtures, …) comes later.

Today's baseline (measured): **no** production file imports a `*.test.ts(x)`
or `__tests__/` file, and no `testing/` directory exists yet. So the new rules
start green and change nothing until the first harness moves.

## The model, as rules

1. **What test code is.** A file inside a plugin is test code if it is named
   `*.test.ts(x)`, sits under a `__tests__/` directory, or sits under a
   `testing/` directory. It is written down once, in `plugin-id/core`.
2. **Where `testing/` may appear.** Only directly under a runtime folder
   (`web/testing/`, `server/testing/`, `core/testing/`, `shared/testing/`, …),
   and never under `e2e/`. A `testing/` directory anywhere else is reported by
   `boundary-rules`, like an unknown folder is today. Because the name `testing`
   then has one meaning everywhere, a file walker can skip it by name, just as
   it already skips `__tests__`.
3. **Test code follows its folder's row.** A file in `server/testing/` uses the
   `server` row. The rows in `boundary-config.ts` do not change.
4. **Only code that verifies may import test code.** Code that verifies is test
   code, plus every file in `check/`. Everything else is code that ships (web,
   server, central, core, cli, bin, lint, e2e, …) and may never import test
   code, in its own plugin or another one. This gate runs **before** the
   own-folder exemption, so `core/foo.ts` importing `./foo.fixture.test.ts`
   fails too.
   - `e2e/` is code that ships under this rule. It drives the running app, so
     it gets no testing barrels.
   - When code that verifies imports test code, the normal row still applies to
     the target folder. So "may import the `testing` barrel of any runtime its
     row already allows" follows directly.
5. **Import grammar.** An import from another plugin may end at
   `@plugins/x/<runtime>` or at `@plugins/x/<runtime>/testing`, and nothing
   deeper. R10 (another plugin's `shared/` is off limits) still blocks
   `shared/testing` from other plugins.
6. **A testing barrel is a barrel.** When a `<runtime>/testing/` folder holds
   TypeScript files, it must have an `index.ts`. That index follows the same
   purity and no-foreign-re-export rules (R3) as `<runtime>/index.ts`.

## Changes

### 1. The definition — `plugins/framework/plugins/plugin-id/core/plugin-id.ts`
Put this beside `RUNTIME_FOLDERS`, `LEAF_FOLDERS` and `PLUGIN_FOLDERS`:
- `TESTING_FOLDER = "testing"` and `TESTS_DIR = "__tests__"`.
- `isTestCodePath(segmentsInsidePlugin: readonly string[]): boolean`. It returns
  true when the basename matches `.test.tsx?`, or when any directory segment is
  `__tests__` or `testing`.
- `VERIFYING_FOLDERS: readonly PluginFolder[] = ["check"]`. These are the
  folders whose ordinary files may import test code.

Export all of them from the barrel. `plugin-id` imports nothing, so no plugin
gets a new dependency cycle.

### 2. `boundary-rules` — `plugins/framework/plugins/tooling/plugins/boundaries/core/`
- `resolve.ts`
  - The `folder` result of `Resolved` gains `test: boolean`, computed in
    `classify()` from the remaining path segments with `isTestCodePath`. A
    barrel specifier like `@plugins/x/core/testing` resolves to
    `{folder: "core", test: true}`, and so does a relative `../core/testing`.
  - `UnfolderedReason` gains `"misplaced-testing"`. This covers a `testing`
    segment that is not directly under a runtime folder, or that sits under
    `e2e/`.
- `evaluate.ts`
  - Move the per-import decision out of the loop in `check.ts` into a pure
    `judgeImport(config, exceptions, source, target)`. It returns `ok`, a
    runtime-isolation violation, a new `test-code` violation, or `cross-plugin`
    (meaning: go on to the zone edges). The order is:
    1. Test gate: `target.test && !(source.test || VERIFYING_FOLDERS.includes(source.folder))`.
    2. Own-folder exemption.
    3. Runtime exceptions.
    4. Row check.
  - `check.ts` calls it and keeps the reporting and the edges.
- `check.ts`
  - Add the violation message: "shipping code cannot import test code". The
    fix names where shared helpers belong: `<runtime>/testing/`, imported only
    from tests or `check/`.
  - Add a `UNFOLDERED_WHY` entry for `misplaced-testing`.
- `boundary-config.ts`: the rows stay unchanged. Add one comment block saying
  that test code inherits its row and that the test gate lives in
  `judgeImport`.

### 3. `plugin-boundaries` — `plugins/framework/plugins/tooling/plugins/checks/plugins/plugin-boundaries/check/index.ts`
- R4 grammar: accept `resolved.tail === "testing"` when `suffixHead` is a
  runtime (`runtimeNames`), using the `TESTING_FOLDER` constant.
- R3: the loop over `web/server/central/core` also visits
  `<runtime>/testing/`. It applies the same "barrel required when TypeScript
  files are present" rule, `checkBarrelPurity`, and `collectForeignReexports`.
  The only difference is that `central/testing` is optional, the same way
  `central/` is.
- R6 cycle edges: unchanged. Edges from test code still count toward the plugin
  graph. This is the stricter choice, and it is also today's behaviour for
  `*.test.ts`. Relax it later only if a real test-only back-edge appears.

### 4. Keep testing code out of a plugin's shipped surface — `plugins/plugin-meta/plugins/parse-utils/core/helpers.ts`
`isSkippedWalkDir` also skips `TESTING_FOLDER`, and `isSourceFile` uses the
shared definition. This matters for more than tidiness. `walkFiles` feeds the
cross-refs facet, which feeds the composition closure (`closure/classify-edges`,
over `SHIPPED_RUNTIME_FOLDERS`). Without the skip, `editor/core/testing/`
importing `codegen/core` and `facets/core` would become a hard edge, and every
composition that ships the editor would bundle build tooling. It would also
list harness symbols under the editor's "Uses" in the generated docs. The skip
is safe because rule 2 guarantees `testing` means the same thing wherever it
appears.

### 5. Docs
- Root `CLAUDE.md`, under "Cross-plugin import grammar": add the
  `/<runtime>/testing` ending and one line on who may import it.
- In the Testing section: shared helpers go in `<runtime>/testing/`.
- `boundaries/CLAUDE.md`: add a "Test code" section that states rules 1–4.
- `plugin-boundaries/CLAUDE.md`: note the R3/R4 additions.

## Out of scope (follow-ups)
- Moving the existing harnesses into `testing/`: `loadBlockHandles` from
  `page/editor/check/` to `editor/core/testing/`, `createTestDb`, the hooktheory
  fixtures, and `pane/web/__tests__/surface-fixture.tsx`.
- Converting the other ad-hoc "is this a test?" predicates to
  `isTestCodePath`. Those checks are `keyed-resource-scope`,
  `table-defs-in-schema-glob`, the routes facet, `plugin-tree/fs-snapshot`,
  `eager-tier-gen` and `web-artifacts/own-files`. Their results do not change
  for today's files. I'll file this with `add_task` once this task lands.

## Verification
- Unit tests:
  - `boundaries/core/resolve.test.ts`: the `test` flag for `.test.ts`,
    `__tests__/`, `core/testing/x.ts`, `@plugins/x/core/testing` and
    `../core/testing`, plus `misplaced-testing` for `core/internal/testing/`
    and `e2e/testing/`.
  - A new `evaluate.test.ts` for `judgeImport`. It covers a production file →
    own `./testing` (denied), a test → a sibling test (ok), `check/` → own
    `../core/testing` (ok), `e2e/` → `core/testing` (denied), `core/x.test.ts`
    → `../server/testing` (denied by the row), and `web/x.test.tsx` →
    `@plugins/y/core/testing` (ok).
  - `./equin test plugins/framework/plugins/tooling/plugins/boundaries plugins/framework/plugins/tooling/plugins/checks/plugins/plugin-boundaries plugins/plugin-meta/plugins/parse-utils`
- `./equin check boundary-rules plugin-boundaries plugins-doc-in-sync type-check`
  passes on the unchanged tree, which confirms the baseline has zero
  violations.
- A throwaway trial, reverted before the build:
  1. Add `plugins/page/plugins/editor/core/testing/index.ts`.
  2. Import it from a `markdown-apply` `*.test.ts` (should pass), from a
     `markdown-apply/core/*.ts` production file (should fail with the test-code
     message), and from an e2e script (should fail).
  3. Add `core/internal/testing/x.ts` (should fail as misplaced).
- `./equin build` (in the background).
