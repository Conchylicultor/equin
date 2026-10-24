# Test helpers discoverable in the plugin docs

## Context

Shared test helpers live in `<runtime>/testing/index.ts` barrels (14 today, e.g.
`createTestDb`, networking's fake transports, `TestSurface`). The generated plugin
docs leave them out on purpose, because they are not public API:

- The exports facet reads only `RUNTIME_FOLDERS` barrels, and `testing` is not a runtime folder.
- `walkFiles` skips `testing/`.
- The `doc-facts-guard` (`codegen/core/doc-facts-guard.ts`) makes the build fail if any
  facet's output names a test-code path.

As a result, an agent writing a test has nowhere to look. CLAUDE.md says "search
`docs/plugins-details.md` before writing a helper", but test fixtures never appear
there, so agents rewrite fixtures that already exist.

Goal: list every testing barrel and what it exports **in `docs/plugins-details.md`**
(the single reference file), and in each owning plugin's CLAUDE.md. The list must be
visibly separate from the plugin's public API, so no reader can mistake a test
helper for API.

## Approach: a labelled "Test helpers" item inside each plugin's entry

Each plugin that has a testing barrel gets one extra item in its
`plugins-details.md` entry. It comes after the per-runtime facts and before
`Plugins:`, under its own label. It is never merged into a runtime's `Exports`
facts:

```md
- **`db-test-fixture`** — Shared throwaway-database fixture for DB-backed test suites.
  - Server:
    - Exports (values): …
  - Test helpers (test code only, not public API):
    - Server: `@plugins/database/plugins/db-test-fixture/server/testing`
      - `createTestDb` (<jsdoc summary>)
      - Types: `TestDb`, `CreateTestDbOptions`
```

It is rendered by a dedicated renderer that docgen calls directly. It is **not** a
facet. Facets feed four generic consumers: docgen, the Studio plugin detail,
contributions, and the PR diff. A test-helpers facet would show up in all four as a
normal plugin fact. It would also have to be exempted from `doc-facts-guard`.
Keeping it out of the facet pipeline means:

- The guard keeps refusing test code in every facet's output, unchanged.
- This renderer is the one place a `…/testing` specifier is written. It is written
  there on purpose, under a label that says "test code only".

### 1. Collector and renderer: `codegen/core/test-helpers-doc.ts` (new)

- `collectTestHelpers(node)`: for each `rt` in `RUNTIME_FOLDERS`, read
  `<dir>/<rt>/testing/index.ts` using parse-utils' `readIfExists`, then `maskSource`,
  then `parseBarrelExports`. This is exactly how the exports facet reads a barrel
  (`facets/plugins/exports/facet/index.ts:27-45`). It uses the node's `dir` from the
  tree `buildEnrichedTree` already builds.
- For each exported value, look up the one-line summary: the first sentence of the
  JSDoc on its declaration, in the file the barrel re-exports it from. The barrels
  themselves are bare re-export lists, so a list of names alone would tell a reader
  little. If parse-utils has no helper for this lookup, add a small one there
  (`declarationSummary(file, name)`). A symbol with no JSDoc is shown by name only.
- `renderTestHelpers(node, bodyIndent): string[]` returns the lines shown above, or
  nothing when the plugin has no testing barrel.

### 2. Wire it into docgen (`codegen/core/docgen.ts`)

- `renderPluginTreeMd` (detail mode): after `renderPluginFacts`, push
  `renderTestHelpers(p, bodyIndent)`.
- `renderPluginClaudeAutogen`: the same call after `renderPluginFacts`, so each
  owning plugin's `## Plugin reference` block carries the same labelled item.
- Compact mode: add a `[test helpers]` marker next to `[load-bearing]` for plugins
  that have a testing barrel. The compact doc is always loaded, so an agent sees
  which plugins publish fixtures without opening the details doc.
- `COMPACT_HEADER` / `DETAILS_HEADER`: extend the existing explanation of markers and
  purpose. For example: "…`[test helpers]` marks plugins publishing shared test
  fixtures; their exports are listed under *Test helpers* in the details doc (test
  code only, not public API)." The details header's "before writing a helper" line
  gains "or a test fixture".

`plugins-doc-in-sync` needs no change, because it re-runs these same render functions.

### 3. Point agents to it

- Root `CLAUDE.md`, Testing section (next to "Test helpers another test reuses go in
  `<runtime>/testing/index.ts`…"): add "Before writing a fixture, search the *Test
  helpers* entries in `docs/plugins-details.md`."
- Codegen plugin `CLAUDE.md` prose: one line explaining why test helpers are
  rendered outside the facet pipeline.

### Out of scope

A "used by" index (which test files use each helper). The cross-refs facet skips
test code on purpose (`parse-utils/core/helpers.ts:583-605`), so building this would
need a separate scan of test files. It can be a follow-up.

## Critical files

- `plugins/framework/plugins/tooling/plugins/codegen/core/docgen.ts` (tree render, CLAUDE.md autogen, headers, compact marker)
- `plugins/framework/plugins/tooling/plugins/codegen/core/test-helpers-doc.ts` (new)
- `plugins/plugin-meta/plugins/parse-utils/core/helpers.ts` (reused: `readIfExists`, `maskSource`, `parseBarrelExports`; maybe a new `declarationSummary`)
- Root `CLAUDE.md`; regenerated `docs/plugins-compact.md`, `docs/plugins-details.md`, and the 14 owning plugins' CLAUDE.md files

## Verification

- `./equin test plugins/framework/plugins/tooling/plugins/codegen`: a unit test
  for `renderTestHelpers` on a small fixture tree. It covers a barrel with value and
  type exports, a JSDoc summary, a symbol with no JSDoc, and a plugin with no barrel
  (no lines, no compact marker).
- `./equin build`, then:
  - `plugins-details.md` has 14 *Test helpers* items. Every `/testing` specifier in
    it sits under that label, and none sits under a runtime's `Exports`.
  - The 14 plugins carry `[test helpers]` in `plugins-compact.md`.
- `./equin check plugins-doc-in-sync` passes.
