# Close the string-embedding false-positive class in the remaining import/value scanners

**Date:** 2026-07-07
**Branch:** claude-web/att-1783435302-a9j5
**Follows:** `56b5175c2 fix(tooling): mask strings in import scanners via shared findImports primitive`

## Problem

Several build-time source scanners call `maskSource(src, { strings: false })`
(mask comments/regex, **keep string interiors**) and then regex for import
statements or ids that live inside string literals. Because string interiors are
kept, an import/marker written INSIDE a string or template literal (a test
fixture, a docs snippet, a codegen template) is matched as if it were real code —
the same false-positive class already fixed in the boundary-rules and
plugin-boundaries checkers via the shared `findImports` primitive
(`plugins/plugin-meta/plugins/parse-utils/core/find-imports.ts`).

The clean, structural pattern (what `findImports`/`findMarkerCalls` do): mask
FULLY (blank string interiors too), match the code STRUCTURE against the masked
text, then read the string value back from the ORIGINAL source at the preserved
offset. `{ strings: false }` is the unsafe shortcut that keeps the value inline
so a single-pass regex can grab it — which is exactly what lets a string-embedded
occurrence match.

## Reference migration pattern (from `56b5175c2`)

For a genuine import-specifier scanner:
1. Change the function to take **raw `src`** (drop the caller's separate
   `maskSource(x, { strings: false })`).
2. Replace the local `FROM_RE`/`SIDE_EFFECT_RE`-shaped regex(es) with
   `findImports(src)`.
3. Read `imp.specifier` (specifier), `imp.typeOnly`, `imp.sideEffect`,
   `imp.clause` (raw bindings text, re-parse locally exactly as before).
4. Filter the flat specifier list with a small `startsWith`/anchored regex.
5. For a construct genuinely OUTSIDE `findImports`'s scope (dynamic `import()`,
   CJS `require()`), keep a hand scan but base it on `maskSource(src)` (FULL
   masking) + read-by-offset, not `{ strings: false }`.

For a construct DETECTOR that keeps `{ strings: false }` but reads no string
value (e.g. `export default {` / `export { … default … } from`): just mask
FULLY — the string interior is never needed and full masking closes the hole.

## Scope decision

The task names the facets `{cross-refs,exports,contributions,slots,routes}`,
qualified "extracting import specifiers/symbols". Faithful reading:

- **Genuine import-specifier/symbol scanners → migrate to `findImports`:**
  `cross-refs`, `contributions/internal/static-parse.parseImports`,
  codegen `collectImportPrefixes`, codegen `pluginImportedIdents`,
  checks `no-relative-server-imports`, `no-plugin-imports-in-core`.
- **Construct detectors wrongly keeping strings → tighten to FULL mask:**
  `no-reexport-default`, `plugin-registry-gen.hasDefaultExport`,
  `fields-eager-gen.hasDefaultExport`, `exports/facet` (feeds
  `parseBarrelExports`, needs no string value).
- **`splitTopLevelStatements` string-naive → mask-based statement boundaries.**
- **`slots` (parseDefineGroup id), `routes` (`/api/` URL), `data-views`,
  `reorderable-slots`, `keyed-resource-scope` → OUT of scope.** These are
  marker/value scanners that legitimately keep the string (the id/URL is the
  value). They are a *distinct* class (marker-id-embedded-in-string) — filed as a
  follow-up to route through `markerCallSpans` read-by-offset.

## Work items

### Group 1 — Facets
1. `facets/cross-refs/facet/index.ts` `parseRawUses`: 4 regexes +
   `maskSource(raw,{strings:false})` → `findImports(raw)` filtered to
   `@plugins/`; parse `clause` for default/named(+alias,+type)/namespace; keep
   side-effect via `imp.sideEffect`; preserve the dedup + `RawUse[]` output.
2. `facets/contributions/facet/internal/static-parse.ts` `parseImports`:
   `namedRe`/`defRe` → `findImports(src)`; rebuild the same
   `Map<local,{local,original,module}>`; default via clause head, named via
   clause `{…}` with `as`/`type`; skip namespace (`* as`). Caller in
   `contributions/facet/index.ts`: drop the `maskSource(…,{strings:false})`
   wrapper — pass `stripTypes(webIndex)` directly (findImports masks internally).
3. `facets/exports/facet/index.ts`: `maskSource(…,{strings:false})` → full mask
   (drop option) feeding `parseBarrelExports`.

### Group 2 — Codegen
4. `codegen/core/plugin-registry-gen.ts` `collectImportPrefixes`: `IMPORT_FROM_RE`
   + `maskSource(…,{strings:false})` → `findImports(readFileSync)`; keep the
   `@plugins/` prefix logic; delete `IMPORT_FROM_RE`.
5. `codegen/core/plugin-registry-gen.ts` `hasDefaultExport`: drop
   `{strings:false}` → full mask.
6. `codegen/core/eager-tier-gen.ts` `pluginImportedIdents`: take raw `src`; use
   `findImports(src)` filtered to `keyword==="import" && !sideEffect &&
   specifier.startsWith("@plugins/")`; word-scan `imp.clause`. Update caller
   `scanWatchedSlot` (drop inline `maskSource`).
7. `codegen/core/fields-eager-gen.ts` `hasDefaultExport`: drop `{strings:false}`
   → full mask.

### Group 3 — Checks
8. `no-reexport-default/check/index.ts`: `maskSource(…,{strings:false})` → full
   mask (regexes still correct on fully-masked source).
9. New `grepImports` helper in `checks/core` (`grep-code.ts` or sibling): reuse
   `listCandidates` (git-grep narrowing, tree-blob-aware) to get candidate files,
   read each, run `findImports`, return `{path, line, specifier, text}` filtered
   by a specifier predicate (`lineAt` for the line). String-safe by construction.
10. `no-relative-server-imports` → `grepImports` (specifier predicate
    `/^(\.\.\/)+plugins\/framework\/plugins\/server-core\/core\//`).
11. `no-plugin-imports-in-core` → `grepImports` (specifier contains
    `/plugins/`|`@singularity/plugin-`|`@plugins/`); apply ALLOWED_DIRS /
    COMPOSITION_ROOTS on path and ALLOWED_PLUGIN_IMPORT_RE on specifier; drop the
    dead `require` branch (its `require\s+['"]` never matches a real `require(`).

### Group 4 — reexport-provenance / parse.ts
12. `plugin-boundaries/check/parse.ts`: make `splitTopLevelStatements(rawSrc)`
    string-safe — compute `masked = maskSource(rawSrc)` (full) for depth/`;`/brace
    boundary detection, slice statement `text` from `maskSource(rawSrc,
    {strings:false})` (comments masked, strings kept) at the same offsets. Delete
    the private `stripComments` (subsumed by `maskSource`).
13. Update callers `reexport-provenance.ts parseFile` and `index.ts
    checkBarrelPurity` to drop the `stripComments` call.

### Group 5 — Structural prevention (lint)
14. New lint rule `no-adhoc-import-scan` under
    `plugins/framework/plugins/tooling/plugins/lint/plugins/import-scan-safety/`:
    flag a **global-flagged** RegExp literal whose source is an import-from /
    bare-import shape (`import`/`export` + `from` + quote-class, or `import`
    followed by whitespace + quote-class), everywhere except
    `parse-utils/core/find-imports.ts`. The `/g` discriminator cleanly exempts the
    single-statement anchored parsers (`extractFromSpecifier`,
    `lastTopLevelFrom`) and grepCode's non-global caller patterns. Forces
    whole-file import scanning through `findImports`.

### Group 6 — Docs
15. Update `parse-utils/CLAUDE.md` (and `checks/CLAUDE.md` as needed): import
    scanning → `findImports`; reserve `{strings:false}` for marker/value scanning
    via `markerCallSpans`/`findMarkerCalls`. Refresh the autogen doc blocks via
    `./equin build`.

### Group 7 — Additional import scanners surfaced by the lint rule
The `no-adhoc-import-scan` sweep found genuine import scanners the task list did
not enumerate (the task list was explicitly non-exhaustive). Migrated the same
way (to `findImports`), else the prevention rule would flag them:
16. `checks/plugins/type-check/check/import-graph.ts` `extractImportSpecifiers`:
    `withFromRe`/`bareRe` → `findImports`; dynamic `import()` kept as a
    full-mask + read-by-offset scan; deleted the copied private `stripComments`.
17. `facets/db-schema/facet/index.ts` `parseImports` → `findImports` (mirror of
    the migrated `contributions` `parseImports`).
18. `facets/resources/facet/parse-resources.ts` `parseImportAliases` →
    `findImports` (keeps type-only imports, matching the old `(?:type\s+)?`).

The lint detector requires BOTH the `import`/`export` keyword AND a `from … quote`
reach — this excludes a SQL `from "table"` parser (`database/server/internal/
client.ts`) that the naive `from + quote` signal would have false-flagged.

### Follow-up (file, do not implement here)
- Audit marker-id/value scanners (`slots` parseDefineGroup, `routes` `/api/`
  regex, `data-views`, `reorderable-slots`) for the marker-id-embedded-in-string
  class; route through `markerCallSpans` read-by-offset.
- `checks/core/scripts/fix-shared-to-relative.ts` is a keyword-less
  `from "@plugins/…/shared"` codemod (a one-off rewrite script, not a build-path
  scanner) — not flagged by the rule; migrate to `findImports` offsets if it is
  ever kept long-term.
