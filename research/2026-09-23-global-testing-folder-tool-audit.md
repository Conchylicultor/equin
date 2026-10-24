# `<runtime>/testing/` in build and docgen tools — audit and fix

_2026-09-23_

## Context

Commit a11350cde moved shared test helpers into `<runtime>/testing/index.ts`
barrels. The task: every tool that walks a plugin's runtime folders must treat
those as test code, not production. Background: Plugin system page,
block-956d1f2d; `research/2026-08-17-global-artifact-address-covers-content.md`.

Most of the work already landed with the boundary commits (63a5afcdb, c99760473,
a11350cde): one predicate, `isTestCodePath` in
`plugins/framework/plugins/plugin-id/core/plugin-id.ts`, and most walkers call it.

## Audit result

| Tool | State |
|---|---|
| Web artifact **address** (`web-artifacts/core/internal/own-files.ts`) | OK. `testing/` and `__tests__/` are skipped when hashing. |
| Web artifact **content** (`own-roots.ts`, `externals.ts`, `vite-builder.ts`) | The bundle only contains what `web/index.ts` reaches, so `web/testing/` does not ship today. **Gap:** the inline audit (`inline-audit.ts`) checks only that a bundled file sits *inside* `web/` or `shared/`. A file under `web/testing/` passes that check, but it is not hashed. If shipping code ever reached it, the stale-bundle failure from the 2026-08-17 doc would come back without any error. Today only the boundary check (`judgeImport` rejects production → test code, same plugin included) stops this, and `--skip-checks` or a disabled lint line gets past it. |
| **Docgen**, db-schema facet (`facets/plugins/db-schema/facet/index.ts` `findDbFiles`) | **Live bug.** It has its own `readdirSync` walker with no test-code skip. `tasks-core/server/testing/install-derived-schema.ts` matches `/schema/` by name, so it is listed as DB schema in `docs/plugins-details.md:34345`. |
| Docgen, other facets (exports, cross-refs, resources, slots, contributions, routes, structure) | OK. They use the shared `walkFiles` in parse-utils, which skips test code, or they read only `<runtime>/index.ts`. |
| Registry codegen (`plugin-registry-gen.ts`) | OK. Entries are `<p>/<folder>/index.ts` with `folder` in `PLUGIN_FOLDERS`, and `testing` is not one of them, so a testing barrel is never registered. The dependency and vendor scan skips test code. |
| Barrel purity | OK. The testing barrel is held to R3 (63a5afcdb), and R12 stops a public barrel from exporting test support. |
| Other codegen (config-origin, fields-eager, data-views, eager-tier) | OK. Each reads a single barrel or uses the shared walker. |
| Tailwind `@source`, css-vars checks, boundary scanner, lint plugin-dirs | These include test code **on purpose**: checks and lint must cover test code too. |

So the bug class is "each walker writes its own skip rule". Two tools got the
rule wrong or incomplete. Fixing just those two leaves the next hand-rolled
walker exposed, so each fix gets an **output-side assertion** that does not
depend on how the walking was done. That is the same pattern as the existing
inline audit.

## Changes

### 1. Docgen: delete the hand-rolled walker (rung 1) and assert on the output (rung 4)

- `db-schema/facet/index.ts`: replace `findDbFiles`'s private `walk()` with the
  shared `walkFiles` from `@plugins/plugin-meta/plugins/parse-utils/core`. Then
  filter by the same name and content rule, and drop the `index.ts` exclusion
  the same way as now. That file also gets the FS-snapshot fast path for free.
  The skip rule then has one owner.
- `framework/plugins/tooling/plugins/codegen/core/docgen.ts` (line ~108, the one
  place every facet's `renderDoc` output is collected): after each facet
  renders, throw if any `DocFact` value contains a repo path whose segments
  answer `isTestCodePath` (match path-like tokens: `plugins/…/*.ts(x)` and
  `@plugins/…/testing`). Name the facet, the plugin and the path in the error.
  A future facet that walks by hand then fails the build instead of quietly
  documenting test code.
- Regenerate: `./equin build` rewrites `docs/plugins-details.md` without
  the `install-derived-schema.ts` line.
- The guard lives in `codegen/core/doc-facts-guard.ts` (tested on its own).
  `db-schema/facet/find-db-files.test.ts` checks that a `server/testing/`
  file whose name matches is not listed.

### 2. Web artifacts: make the inline audit exact (rung 4, one shared predicate)

- `own-files.ts`: pull the walk's skip rules into `isSkippedDir` /
  `isSkippedFile`, and export `isHashedFile(roots, abs)`: inside one of the
  roots **and** not skipped by those rules (test code, `node_modules`,
  `public`, `dist*`). The walk and the assertion share one definition.
- `inline-audit.ts`: replace bare root containment with `isHashedFile`, and
  name test code in the error message.
- The builder source digest changes, so every artifact rebuilds once under the
  new identity. That is expected; the 2026-08-17 doc describes it.
- Tests: extend `inline-audit.test.ts` with a bundled `web/testing/x.ts` id
  (must throw) and a `web/x.ts` id (must pass). Add `own-files.test.ts` cases for
  `isHashedFile`.

### 3. Docs

- `web-artifacts/CLAUDE.md` and the 2026-08-17 research doc: one paragraph saying
  the audit now checks the hashed file set, not only the root folders, and why
  (test code sits inside the roots).
- `facets/CLAUDE.md`: facets enumerate source with the shared `walkFiles`, and
  docgen refuses a test-code path in the output.

## Out of scope

- Making the testing barrels discoverable in the plugin docs (so agents find
  `createTestDb` before writing their own). Filed as task-1790152660458-ewtdvv.

## Verification

1. `./equin test plugins/framework/plugins/tooling/plugins/web-artifacts plugins/plugin-meta/plugins/facets plugins/framework/plugins/tooling/plugins/codegen`
2. `./equin build` (background; then `./equin await`). Confirm
   `build-status.json` is `ok` and that the whole artifact fleet rebuilt and passed the audit.
3. `git diff` on `docs/plugins-details.md` shows the
   `install-derived-schema.ts` line removed and nothing else removed.
4. Negative check by hand, then reverted: make a shipping `web/*.ts` in some plugin
   import `./testing`, and build with `--skip-checks`. The artifact build must fail
   with the inline-audit test-code error.
5. `./equin check plugins-doc-in-sync plugin-boundaries type-check`.
