# Facets v3 Phase 7 — Generic plugin discovery

> Follow-on to `research/2026-06-02-global-facets-rendering-separation-v3.md` (Phase 7).
> Adjacent infra to the facet work; not a blocker for Phases 1–6.

## Context

Plugin discovery (`findAllPluginDirs` in
`plugins/plugin-meta/plugins/plugin-tree/core/internal/plugin-tree.ts:52`) decides whether a
directory is a plugin by checking for a **hardcoded set of recognized sub-folder names**
(`web/server/central/core/shared/check/lint/facet`) or a `plugins/` umbrella. This list is
friction: every time a new runtime or collected-dir type is added, discovery must be edited.
The *same* hardcoded-list friction exists in two more places:

- `plugin-boundaries` check — `KNOWN_PLUGIN_DIRS`
  (`.../checks/plugins/plugin-boundaries/check/index.ts:38`) duplicates the list (plus `bin`,
  `scripts`) to reject unknown directories (R11).
- `boundaries/core/resolve.ts:5` — a `RUNTIMES` set (out of scope here; noted as follow-up).

**Goal.** Make discovery **purely positional**: every `**/plugins/<name>/` directory is a
plugin, irrespective of the sub-folders/files it contains (leaves included, so they are
documented and appear in the UI). Then **flag non-standard folders and stray top-level source
files generically in the UI** (Forge plugin detail pane), where "standard" is *derived* from
the collected-dir registry — never a hardcoded allow-list.

### Decisions (confirmed with user)

1. **Discovery gate = purely positional.** A directory is a plugin iff it sits at a plugin
   position (direct child of `plugins/`, or direct child of any nested `plugins/` folder).
   No content gate. Skip `node_modules` and dot-dirs only (non-source noise, a stable denylist
   that never grows). This newly promotes exactly 3 directories to plugin nodes:
   `framework/plugins/web-core`, `framework/plugins/cli`,
   `conversations/plugins/conversation-view/plugins/push-counter`. (Verified: these are the
   only positional dirs lacking a barrel/umbrella today; all already have `package.json`.)

2. **Flag surface = detail pane only.** A new `plugin-view` Section sub-plugin (mirrors the
   existing `runtimes` section) renders anomalies in the Forge plugin detail pane. A **repo-wide
   catalog table** of anomalies is a tracked follow-up task (created separately), not part of
   this change.

3. **web-core conformance = self-declared composition-root marker.** Purely-positional
   discovery makes `web-core` a plugin node, which hard-fails the load-bearing
   `plugin-boundaries` check: R1 (package name is `@singularity/web`, not the expected
   `@singularity/plugin-framework-web-core`) and R3 (`web/` has TS files but no `web/index.ts`
   barrel — it's the SPA bootstrap, not a contribution plugin). Resolution: a generic,
   self-declared opt-out — `"singularity": { "compositionRoot": true }` in the plugin's
   `package.json`. The check honors it (skips R1/R3/R11 for self-declared roots); the UI flags
   it ("composition root"). No hardcoded name list; matches the "flag non-standard, don't force
   conform" philosophy. Only `web-core` needs the marker (`cli`/`push-counter` pass after a
   build).

## Blast-radius (verified)

Promoting the 3 nodes was analyzed against every `buildPluginTree` consumer:

| Consumer | Effect |
|---|---|
| `plugin-boundaries` R1/R3/R11 | `web-core` hard-fails → fixed by `compositionRoot` marker + check honoring it. `cli`/`push-counter` pass. |
| `boundary-rules` (boundary-config) | Safe — `cli/bin`, `web-core/web` files resolve to `runtime:null`/`web`; `plugin.**→plugin.**` + web→core edges already allow them. No new violations. |
| docgen / `plugins-doc-in-sync` / `plugins-have-claudemd` | `./equin build` auto-creates `cli/CLAUDE.md` (none today), appends the autogen block to `web-core`/`push-counter`, and writes the 3 new entries into `docs/plugins-*.md`. Docgen runs before checks in `build`, so they pass post-build. |
| `plugin-registry-gen` (`*.generated.ts`) | Safe — none of the 3 have a `<runtime>/index.ts` default export, so no registry entry. |
| `no-reexport-default`, `facets:render-complete` | Safe — none have `web/index.ts` barrels. |
| plugin-view tree endpoint / UI, `compute-plugin-diff` | Node count increases; informational. Safe. |

## Plan

### A. Purely-positional discovery — `plugin-tree.ts`

`plugins/plugin-meta/plugins/plugin-tree/core/internal/plugin-tree.ts`

- Rewrite `findAllPluginDirs` (52–91): drop the `hasWeb/hasServer/…/hasBarrel` checks and the
  `hasBarrel || isUmbrella` gate. Push **every** directory the walk visits at a plugin position
  (`dir !== pluginsRoot`). Keep the existing recursion shape (top-level children + nested
  `plugins/` children only) — that already enforces "plugin position". Add a denylist guard:
  skip dirs named `node_modules` or starting with `.` when walking.
- `collectCoreFields` (100): read the composition-root marker from `package.json`
  (`pkg.singularity?.compositionRoot === true`), reusing the existing package.json parse block
  (138–146 reads `pkg.singularity?.collapsed`). Add `compositionRoot: boolean` to the internal
  `PluginNode` (29–41). Structural identity, consistent with `loadBearing`/`collapsed` (v3 D4).

### B. Generic "standard folders" helper — `codegen/core`

`plugins/framework/plugins/tooling/plugins/codegen/core/plugin-registry-gen.ts` (+ barrel export)

- Add `export async function standardPluginDirs(root): Promise<Set<string>>` returning the
  generic set: `(await discoverCollectedDirs(root)).map(d => d.dir)` (auto-grows:
  web/server/central/facet/check/lint) **plus** the fixed structural folders
  `core`, `shared`, `plugins`, `bin`, `scripts`. The collected/runtime part is generic; the
  fixed set is the genuinely-stable structural conventions that never grow when a new
  runtime/collected-dir type is added (which is the friction being removed).
- Export `standardPluginDirs` from `codegen/core/index.ts`.

This is importable by both the UI server (plugin-view) and the boundaries check — no cycle
(`codegen → plugin-tree`; neither imports plugin-view nor the check).

### C. Use the generic helper in `plugin-boundaries` (R11 + composition-root skip)

`.../checks/plugins/plugin-boundaries/check/index.ts`

- Replace the hardcoded `KNOWN_PLUGIN_DIRS` (38–46) usage in `checkUnknownDirs` (R11) with
  `await standardPluginDirs(root)` (removes the duplicated list / its friction).
- Carry `compositionRoot` from the tree node into `PluginDir` (66–73, 92–96).
- Skip R1, R3, R11 when `p.compositionRoot` (102–136). Keep import-grammar rules (R4–R12)
  unchanged — `web-core/web/App.tsx` + its test are already exempt via `FRAMEWORK_FILES`; the
  remaining web-core files pass. This is an **additive** exemption honoring a self-declared
  marker, not an ad-hoc skip-list entry.

### D. API type + endpoint schema — `plugin-view/core`

`plugins/plugin-meta/plugins/plugin-view/core/types.ts`

- Add to the API `PluginNode`: `compositionRoot: boolean`,
  `folders: { name: string; standard: boolean }[]`, `looseFiles: string[]`.

`plugins/plugin-meta/plugins/plugin-view/core/endpoints.ts`

- Extend `pluginNodeSchema` with the three new fields (response schema is required for
  `useEndpoint` to return data).

### E. Classify in the consumer — `plugin-view/server/tree-handler.ts`

- Compute the standard set once per request: `const std = await standardPluginDirs(root)`
  (root = `dirname(PLUGINS_DIR)`).
- In `toApiNode`: `readdirSync(node.dir, { withFileTypes: true })` →
  `folders` = immediate sub-dirs (excluding `node_modules`/dot-dirs), each tagged
  `standard: std.has(name)`; `looseFiles` = immediate `*.ts`/`*.tsx` files (top-level source
  that belongs inside a runtime folder — extension-based, not a name allow-list). Pass
  `compositionRoot` through. (`node.facets` continues to pass through unchanged.)

  Classification lives here (not in `plugin-tree`) because it needs `discoverCollectedDirs`
  from `codegen`, and `plugin-tree` cannot import `codegen` (would cycle). `plugin-view/server`
  can.

### F. New UI sub-plugin — `plugin-view/plugins/structure`

Mirror `plugins/plugin-meta/plugins/plugin-view/plugins/runtimes/` byte-for-byte in shape:

- `web/index.ts` — `PluginViewSlots.Section({ id: "structure", label: "Structure", component: StructureSection })`.
- `web/components/structure-section.tsx` — receives `{ node }`. Renders, inside `<Section title="Structure">`:
  - a `Badge variant="info"` "composition root" chip when `node.compositionRoot`;
  - one `Badge variant="warning"` (icon `MdWarningAmber`, `size-3`) per non-standard folder
    (`folders.filter(f => !f.standard)`);
  - one `Badge variant="warning"` per `looseFiles` entry.
  - **Early-return `null`** when not a composition root and there are no non-standard folders
    and no loose files (same empty-guard pattern as `SubPluginsSection`).
- `package.json` (`@singularity/plugin-plugin-meta-plugin-view-structure`) + `CLAUDE.md`
  (write only the `# structure` heading; build codegen fills the AUTOGENERATED block).
- Register the default export in `web/src/plugins.ts` (registry exclusivity rule).

### G. Follow-up task (separate)

Create a task: *"Structure-anomalies catalog table — a repo-wide Forge catalog view listing
every plugin with non-standard folders / loose files, via the generic facet pipeline
(Catalog.FacetTable)."* This is the catalog counterpart to the detail-pane Section.

## Critical files

| File | Change |
|---|---|
| `plugins/plugin-meta/plugins/plugin-tree/core/internal/plugin-tree.ts` | A — positional `findAllPluginDirs`; `compositionRoot` field |
| `plugins/framework/plugins/tooling/plugins/codegen/core/plugin-registry-gen.ts` | B — `standardPluginDirs()` |
| `plugins/framework/plugins/tooling/plugins/codegen/core/index.ts` | B — export it |
| `plugins/framework/plugins/tooling/plugins/checks/plugins/plugin-boundaries/check/index.ts` | C — generic R11 + compositionRoot skip |
| `plugins/plugin-meta/plugins/plugin-view/core/types.ts` | D — API fields |
| `plugins/plugin-meta/plugins/plugin-view/core/endpoints.ts` | D — schema |
| `plugins/plugin-meta/plugins/plugin-view/server/internal/tree-handler.ts` | E — classify |
| `plugins/plugin-meta/plugins/plugin-view/plugins/structure/**` | F — new sub-plugin |
| `web/src/plugins.ts` | F — register |
| `plugins/framework/plugins/web-core/package.json` | mark `singularity.compositionRoot: true` |

## Verification

1. `./equin build` — must succeed; regenerates `cli/CLAUDE.md` (new), updates
   `web-core`/`push-counter` CLAUDE.md, and `docs/plugins-*.md` (3 new entries). Commit the
   regenerated files.
2. `./equin check` — all green. Specifically `plugin-boundaries` (web-core skipped via
   marker; R11 now generic), `plugins-doc-in-sync`, `plugins-have-claudemd`,
   `migrations-in-sync`, `eslint`.
3. Confirm the 3 new nodes appear in `docs/plugins-compact.md`.
4. Forge UI (`http://<worktree>.localhost:9000`, Forge → plugin detail):
   - `web-core` → "Structure" section shows "composition root" + flagged `vite.config.ts` /
     `vitest.config.ts` loose files.
   - `cli` → no Structure section (bin/scripts are standard; no loose source).
   - a normal plugin (e.g. `tasks`) → no Structure section.
   - `database/plugins/migrations` → flags the `data/` folder + `drizzle.config.ts`.
   Verify with `e2e/screenshot.mjs --url …/forge --click <plugin>`.
5. `GET /api/plugin-view/tree` returns `folders`/`looseFiles`/`compositionRoot` populated.

## Tradeoffs / notes

- **Purely positional vs. package.json gate.** Positional is what the user chose; for the
  current tree it yields the same 3 extra nodes as a `package.json` gate (every positional dir
  already has a `package.json`). Positional is the simplest faithful expression of "every
  `plugins/<name>/` is a plugin."
- **`bin`/`scripts`/`core`/`shared`/`plugins` are a fixed structural set** in
  `standardPluginDirs`. They are not runtime/collected-dir *types* (which now auto-register via
  `discoverCollectedDirs`); they're stable conventions that don't grow, so listing them is not
  the friction being removed. Documented in the helper.
- **The UI will flag some intentional-but-non-standard items** (config `.ts` files, `data/`).
  That is the point — it is an informational review signal, not a build error.
- **Out of scope:** the third hardcoded list (`RUNTIMES` in `boundaries/core/resolve.ts`) and
  the catalog-table surface (tracked as a follow-up task).
