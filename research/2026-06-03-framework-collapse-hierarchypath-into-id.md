# Collapse plugin `_hierarchyPath` into `id`

## Context

A recent commit (`a51200f8`, "derive plugin id from hierarchy path instead of
hand-authoring") made each plugin's `id` loader-derived from its hierarchy path.
As a result, `id` and `_hierarchyPath` now hold **byte-identical** values on
every runtime's plugin/contribution objects:

- Plugins: `plugin.id === plugin._hierarchyPath` (both assigned from
  `entry.hierarchyPath` in all three loaders).
- Contributions: `_pluginId === _hierarchyPath` (both stamped from the owning
  plugin's `id`/`_hierarchyPath`, which are themselves identical).
- Downstream `ConfigRegistration`: `pluginId === hierarchyPath` (mapped from the
  two identical contribution fields).

Two fields carrying the same value is redundant and confusing. This change
consolidates onto the single canonical identity field — `id` on plugins,
`_pluginId` on contributions, `pluginId` on `ConfigRegistration` — and deletes
`_hierarchyPath` everywhere. The only runtime consumer of `_hierarchyPath` is
`config_v2` (for building config store paths); it switches to read `_pluginId`,
which holds the same slash-form hierarchy path. No on-disk config paths change,
so **no data migration is needed**.

The generated registry entries keep their `hierarchyPath` field — that is the
source the loaders read to derive `id`. We are only removing the *redundant
second copy* that was stored on the live plugin/contribution objects.

## Approach

Delete `_hierarchyPath` from all three runtimes' type definitions, loaders, and
contribution-stamping code; point `config_v2`'s reads at `_pluginId`; and
collapse `ConfigRegistration`'s redundant `hierarchyPath` field into `pluginId`.

### 1. web-sdk (framework)

- `plugins/framework/plugins/web-sdk/core/types.ts`
  - Remove `_hierarchyPath?: string;` from `Contribution` (line 21).
  - Remove `_hierarchyPath?: string;` + its comment from `PluginDefinition`
    (lines 60–61).
  - Update the `LoadedPlugin` JSDoc (lines 78–86) that says "`id` equals the
    plugin's `_hierarchyPath`" → reword to "`id` is the slash-form hierarchy
    path …" (drop the now-deleted field name).
- `plugins/framework/plugins/web-sdk/core/loader.ts`
  - Remove `plugin._hierarchyPath = entry.hierarchyPath;` (line 40). Keep the
    `id` derivation (line 31, 39) unchanged.
- `plugins/framework/plugins/web-sdk/core/context.tsx`
  - Remove `_hierarchyPath: p._hierarchyPath,` from the contribution stamping
    map (line 59). `_pluginId: p.id` (line 56) already carries the value.

### 2. server-core (framework)

- `plugins/framework/plugins/server-core/core/types.ts`
  - Remove `_hierarchyPath?: string;` + comment from `ServerPluginDefinition`
    (lines 57–58).
- `plugins/framework/plugins/server-core/core/contributions.ts`
  - Remove `_hierarchyPath?: string;` from `ServerContribution` (line 6).
  - Remove `_hierarchyPath?: string;` from the `ServerContributionToken
    .getContributions()` return type (line 16).
  - Remove the `c._hierarchyPath = (p as {...})._hierarchyPath;` stamping line
    (line 58) in `collectContributions`. `c._pluginId = p.id` (line 55) already
    carries the value.
- `plugins/framework/plugins/server-core/bin/index.ts`
  - Remove `plugin._hierarchyPath = e.hierarchyPath;` (line 36). Keep
    `plugin.id = e.hierarchyPath;` (line 35).

### 3. central-core (framework) — approved for this change

- `plugins/framework/plugins/central-core/core/types.ts`
  - Remove `_hierarchyPath?: string;` + comment from `CentralPluginDefinition`
    (lines 36–37).
- `plugins/framework/plugins/central-core/bin/index.ts`
  - Remove `plugin._hierarchyPath = e.hierarchyPath;` (line 30). Keep
    `plugin.id = e.hierarchyPath;` (line 29).

(Nothing reads central's `_hierarchyPath`; these two deletions just keep the
three runtimes consistent.)

### 4. config_v2 — switch reads to `_pluginId`

- `plugins/config_v2/server/internal/registry.ts`
  - Line 73: `const hierarchyPath = contribution._hierarchyPath;` →
    `const pluginId = contribution._pluginId;` and use `pluginId` for the
    `storePath` / `userOriginPath` / `userOverwritesPath` construction
    (lines 81, 84, 85). Update the skip-warning message (line 76) to reference
    `_pluginId`.
- `plugins/config_v2/web/internal/use-config.ts`
  - Lines 15–16, 21: read `reg?._pluginId` instead of `reg?._hierarchyPath`.
- `plugins/config_v2/web/internal/use-set-config.ts`
  - Lines 15–16, 19: read `reg?._pluginId` instead of `reg?._hierarchyPath`.
- `plugins/config_v2/web/internal/use-config-registrations.ts`
  - Drop the `hierarchyPath: string;` field from the `ConfigRegistration`
    interface (line 9).
  - Filter on `c._pluginId && c._pluginName` (drop `&& c._hierarchyPath`,
    line 21).
  - Build `storePath` from `c._pluginId` (line 27); remove the `hierarchyPath`
    mapping (line 26).

### 5. `ConfigRegistration` consumers — use `pluginId`

- `plugins/config_v2/plugins/settings/web/components/config-nav.tsx`
  - Line 18: `reg.hierarchyPath.split("/")` → `reg.pluginId.split("/")`.
  - Line 64: `orphans.map((r) => r.hierarchyPath)` → `r.pluginId`.
  - Line 77: `path: reg.hierarchyPath` → `path: reg.pluginId`.
- `plugins/config_v2/plugins/settings/web/internal/prune-config-tree.ts`
  - Line 22: update the doc comment referencing `reg.hierarchyPath` →
    `reg.pluginId`.

(Other `ConfigRegistration` consumers — `config-detail.tsx`, `config-nav-row.tsx`,
`config-tree-node.tsx`, `use-config-row-state.ts`, the setup-wizard, theme
plugins — reference `pluginId`/`storePath`/`descriptor`/`pluginName`, not
`hierarchyPath`, so they need no change.)

## Critical files

- `plugins/framework/plugins/web-sdk/core/{types.ts,loader.ts,context.tsx}`
- `plugins/framework/plugins/server-core/core/{types.ts,contributions.ts}`,
  `.../server-core/bin/index.ts`
- `plugins/framework/plugins/central-core/core/types.ts`, `.../bin/index.ts`
- `plugins/config_v2/server/internal/registry.ts`
- `plugins/config_v2/web/internal/{use-config.ts,use-set-config.ts,use-config-registrations.ts}`
- `plugins/config_v2/plugins/settings/web/components/config-nav.tsx`
- `plugins/config_v2/plugins/settings/web/internal/prune-config-tree.ts`

## Docs to update

These hand-written CLAUDE.md lines describe the loader stamping `_hierarchyPath`
and should be re-checked / reworded if they name the field. The autogen
reference blocks are regenerated by `./equin build` and need no manual
edit. (The `plugins-doc-in-sync` check enforces sync.)

- `plugins/framework/plugins/web-sdk/CLAUDE.md` — confirm no stale
  `_hierarchyPath` mention.
- The existing memory note `project_plugin_id_derived_from_path` already
  captures "id is loader-injected from hierarchy path"; this change reinforces
  it (single field now). Consider a one-line memory update noting
  `_hierarchyPath` was removed in favor of `id`/`_pluginId`.

## Verification

1. `./equin check --plugin-boundaries` and the full `./equin check`
   — confirm no boundary / doc-sync regressions.
2. `./equin build` — TypeScript compiles (the removed optional fields
   surface any missed reader as a type error), migrations regenerate to a no-op,
   server restarts.
3. Functional check of config_v2 (the only `_hierarchyPath` consumer) at
   `http://att-1780502645-uusu.localhost:9000`:
   - Open **Settings** (config_v2 settings pane). Confirm the config tree
     renders with correct hierarchy grouping (exercises
     `useConfigRegistrations` + `config-nav` `pluginId`/`hierarchyId` logic).
   - Edit a config field and save (exercises `useSetConfig` → `setConfigByPath`
     → server `registry.ts` store-path build). Confirm the value persists and
     the on-disk path under `~/.singularity/config/<plugin-tree>/` is unchanged
     from before.
   - Reload and confirm `useConfig` reads the saved value back (exercises the
     `use-config.ts` path key).
   - Use `e2e/screenshot.mjs` to script the open-settings + edit-field flow and
     capture before/after if a manual check is ambiguous.
4. `query_db` sanity: confirm no config-related runtime errors in logs after
   restart.
