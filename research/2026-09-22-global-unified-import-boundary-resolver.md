# One import resolver for boundary rules, inside and across plugins

Design: Plugin system page, Questions block `block-956d1f2d-572c-4769-8596-eeb747307929`
(agent card `block-4eaa5f71-…`), from conversation `conv-1790075869-vzax`.

## Context

The runtime table in `boundaries/boundary-config.ts` says which folder may import
which (`web → web, core, shared`, `core → core`, …). But `boundary-rules`
(`boundaries/core/check.ts`) only enforces it for some imports:

- It reads only `@plugins/…` specifiers (`ZONE_SPECIFIER_RE`). A plugin's own
  relative imports (`../server/x`) are never read.
- It skips any import whose source and target are the same plugin
  (`if (source.zone === target.zone) continue`).

Two patches each cover one slice of the gap:

- the lint rule `runtime-isolation/no-cross-runtime-import`: web/core/server/central
  against their own server/web/provision;
- `plugin-boundaries` R12 `shared-wrong-runtime`: who may import their own `shared/`.

Every other own-folder edge is unchecked. For example, a plugin's `e2e/` or `cli/`
importing its own `web/`, or `core/` importing its own `data-dirs/`.

Outcome: one resolver classifies every import (relative, or `@plugins/…`) by its
target plugin and target folder. The same table applies whether or not the target
is in the same plugin. Then the lint rule and R12 are deleted.

Only two things differ for an import that stays inside one plugin. Both are
already enforced by `plugin-boundaries`, and this change keeps them there:

- `shared/` is reachable only from the same plugin (R10, R8, `shared-use-relative`);
- deep paths are allowed only inside a plugin (R4, the barrel grammar, applies across plugins only).

Out of scope (separate cards on the same page): the "is a test" dimension and the
`testing/` barrels, and "no free folders". Folders with no row (`check/`, `lint/`,
`bin/`, `scripts/`, `fixtures/`, `facet/`, loose root files) stay unpoliced as
importers and as targets, exactly as they are across plugins today
(`checkRuntime(null) → true`). Also out of scope: splitting `core/` into pure code
and Node-only code. `core/` keeps both meanings for now.

## What the unified rule flags today

Measured over all 8,655 tracked `plugins/**/*.ts(x)`, same-plugin imports only,
judged against the current table:

| Edge | Count | Files |
|---|---|---|
| `core → data-dirs` | 7 | `checks/core/{cache,progress-log,warm-base}.ts`, `database/core/internal/config.ts`, `web-artifacts/core/internal/store.ts`, `signal-origin/plugins/sink/core/internal/lines.ts`, `reports/plugins/outbox/core/internal/file-report.ts` |
| `shared → server` | 1 | `apps/sonata/sources/midi/shared/pedal-roundtrip.test.ts` imports `../server/internal/bach-prelude` |

No `e2e/`, `cli/` or `provision/` edge breaks the table today.

## Changes

### 1. Resolver (`boundaries/core/resolve.ts`)

Replace the separate `resolveImport(specifier)` with
`resolveImport(fromRelFile, specifier): ResolvedZone | null`:

- `@plugins/…` works as today: the longest matching plugin prefix, then the next segment as the folder.
- `./` and `../` specifiers are resolved against the importing file's directory
  (posix segment arithmetic), then classified with the existing `resolveFile`.
  This is the same longest-prefix plugin lookup, followed by the first segment
  after the plugin dir as the folder.
- Anything else (npm packages, specifiers that leave `plugins/`) → `null`, as now.

`ResolvedZone` keeps `{ zone, runtime }`. `runtime` is still `null` for a folder
with no row, or a loose file at the plugin root.

### 2. Check (`boundaries/core/check.ts`)

- `extractCrossZoneImports` → `extractImports`: keep `@plugins/…` and relative
  specifiers. Keep using `findImports`, so `export … from` and `import()` are
  covered, and so is `import type`. Type-only imports are checked the same way,
  as the lint rule did.
- Delete the `source.zone === target.zone` skip. The runtime check (and
  `runtimeExceptions`) runs for every resolved import.
- The zone-DAG edge evaluation and `realizedEdges` (cycle detection) stay
  cross-plugin only. Guard them with `if (source.zone !== target.zone)`, placed
  after the runtime check. Allow/deny edges are a between-plugins concept, and
  adding intra-plugin folder edges to the cycle graph would only add noise.
- The violation message says `(same plugin)` when the zones are equal. The fix
  hint names `core/` (public) or `shared/` (private) as the channel.
- The CPU-yield loop is unchanged. The file set is the same, only more specifiers
  per file get parsed.

### 3. Fix the 8 violations

- **`core → data-dirs` ×7.** These files are host-only (Node) code that sits in
  `core/`, under the current "core has two meanings" model, and no `web/` file
  reaches any of these `core/` barrels today. Record them as scoped
  `runtimeExceptions`, one line per plugin, each with a comment explaining why:
  ```
  "plugin.database.core -> plugin.database.data-dirs",
  "plugin.framework.tooling.checks.core -> plugin.framework.tooling.checks.data-dirs",
  "plugin.framework.tooling.web-artifacts.core -> plugin.framework.tooling.web-artifacts.data-dirs",
  "plugin.packages.signal-origin.sink.core -> plugin.packages.signal-origin.sink.data-dirs",
  "plugin.reports.outbox.core -> plugin.reports.outbox.data-dirs",
  ```
  (Zone names use the plugin-tree node id. Confirm the exact spelling when
  implementing, e.g. whether `plugins/` segments are dropped.) The comment above
  the `web`/`core` rows in `boundary-config.ts` loses its "KNOW WHAT THIS DOES
  AND DOES NOT CATCH" paragraph, because same-plugin relative edges are now
  policed. It says the exceptions above are the known host-only `core/` files.
- **`shared → server` ×1.** Move `midi/shared/pedal-roundtrip.test.ts` to
  `midi/server/`, since it exercises a server fixture. Adjust its relative
  imports. Its `shared/` imports become `../shared/…`, which `server` may import.

### 4. Delete the patches

- Delete `lint/plugins/runtime-isolation/lint/no-cross-runtime-import.ts` and its
  entry in `lint/index.ts`. **Keep** `no-deep-own-folder-import` and `own-tree.ts`.
  That rule is about the web-artifact builder turning a deep own-folder import
  into a barrel import, which is a different question from runtime isolation.
  Update `runtime-isolation/CLAUDE.md` (rules list, "Why a lint rule…", the
  outage section → one line pointing to `boundary-rules`) and the plugin's
  `package.json` description.
- `plugin-boundaries/check/index.ts`: delete both R12 branches (the relative loop,
  and the `sharedImporters` half of the same-plugin alias branch). The same-plugin
  `@plugins/<own>/shared` branch keeps only `shared-use-relative`.
- `boundaries/core/runtimes.ts` + `core/index.ts`: delete `sharedImporters`. Its
  only reader was R12.
- Comments: `boundaries/CLAUDE.md` (drop the `sharedImporters`/R12 paragraph, and
  add a line saying boundary-rules reads relative imports and applies the table
  inside a plugin), `boundary-config.ts` (the `provision` comment's "short-circuits
  for the same plugin" line), `pane/lint/no-core-define-route-in-web.ts:63` (it
  says it mirrors the deleted rule; reword it to stand alone).

### 5. Tests

`boundaries/core/resolve.test.ts` (new, pure) covers:
- relative into own `server/`, `shared/`, `data-dirs/`, and a deep file;
- a child plugin resolving `../../..` into its parent (a different zone);
- self-alias `@plugins/<own>/web`;
- relative to a loose root file (`runtime: null`);
- a specifier leaving `plugins/` (`null`).

## Critical files

- `plugins/framework/plugins/tooling/plugins/boundaries/core/{resolve,check,runtimes,index}.ts`, `boundary-config.ts`, `CLAUDE.md`
- `plugins/framework/plugins/tooling/plugins/checks/plugins/plugin-boundaries/check/index.ts`
- `plugins/framework/plugins/tooling/plugins/lint/plugins/runtime-isolation/{lint/index.ts, lint/no-cross-runtime-import.ts, CLAUDE.md, package.json}`
- `plugins/apps/plugins/sonata/plugins/sources/plugins/midi/{shared→server}/pedal-roundtrip.test.ts`

## Verification

1. `./equin test plugins/framework/plugins/tooling/plugins/boundaries`
2. Negative probes (temporary, reverted afterwards). Each must fail `boundary-rules`:
   - a `core/` file doing `import "../server/x"`, which the lint rule caught before;
   - an `e2e/` file importing `../web`, which was unchecked before;
   - a `cli/` file importing its own `../web`;
   - a `core/` file importing its own `../shared`, which R12 caught before.
3. `./equin check boundary-rules plugin-boundaries type-check`: green.
4. `./equin build` (background), then check that `build-status.json` says `ok`.
   Docs regenerate (`plugins-doc-in-sync`) because the lint plugin's description changed.
