# Unify `hierarchyId` / `hierarchyPath` / `pluginId` into a single `PluginId`

## Context

The same logical value — a plugin's position in the plugin tree — currently
travels under **three names and two encodings**:

| Name | Encoding | Where |
| --- | --- | --- |
| `hierarchyId` | dot `active-data.conv` | `PluginNode` (build-time tree) |
| `hierarchyPath` | slash `active-data/conv` | generated registry `CollectedEntry`, config_v2 internals |
| `id` / `_pluginId` / `pluginId` | slash `active-data/conv` | `LoadedPlugin.id`, contributions, config, URL params, DB |

They are the *same identity*. The slash form is **not** a filesystem path (the
real path interleaves `/plugins/`: `active-data/plugins/conv`), so neither
encoding has a claim to being canonical — the dot/slash split is incidental.
The duplication shows up as a dot→slash `split(".").join("/")` swap **inlined in
three codegen sites** plus a fourth dot→`/plugins/` swap in plugin-health, a
slash→dot swap in config settings, and a URL param named `:pluginId` that
actually carries a dot-form `hierarchyId` (a latent type confusion).

**Goal:** one branded `PluginId` type, one canonical encoding (**dot**), one
helper module owning the derived path forms, and one consistent field-naming
convention. Keep the on-disk `config/<slash>/` layout exactly as-is (no config
migration). Collapse the scattered inline separator-swaps into named helper
calls.

### Decisions (settled with the user)

- **Canonical encoding = dot.** `LoadedPlugin.id`, `_pluginId`, `PluginNode.id`,
  the generated registry entry id, and every reference all become dot-form.
- **`config/<pluginId>/` stays slash on disk** → the dot→slash conversion
  survives, but at exactly one boundary, via the shared helper.
- **Naming convention** (standard self-vs-foreign-key rule):
  - Type: **`PluginId`** (branded dotted string), used everywhere.
  - An entity's **own** id → **`id`** (`PluginNode.id`, `LoadedPlugin.id`,
    `CollectedEntry.id`). `plugin.pluginId` would be redundant.
  - A **reference** to a plugin from elsewhere → **`pluginId`** (config
    override field, reorder manifest, plugin-health column, `:pluginId` URL
    param).
  - Framework-injected contribution tag → **`_pluginId`** (kept — underscore
    marks loader-injected and disambiguates from a contribution's own `id`).
  - `hierarchyId` / `hierarchyPath` as *names of the identity* are **deleted**.
    (config_v2's internal `hierarchyPath` variable is kept — there it genuinely
    names a slash *path*, derived once via `asPath`.)
- **Helper home = new `framework/plugins/plugin-id`** primitive (recommended,
  user-approved).

### Answer to "do the 4 duplications survive?"

No — they collapse:
- `plugin-registry-gen.ts` and `reorderable-slots-gen.ts` **emit dot directly**
  → their conversions are **deleted** (the registry/manifest now carry the
  canonical id).
- `config-origin-gen.ts` (config stays slash) and plugin-health
  (`/plugins/` fs path) **keep converting**, but through the **single helper**
  (`asPath` / `asFsPath`).
- config_v2 server/web gain **one** `asPath` call each at the store-path
  boundary (previously got slash "for free" because `_pluginId` was slash).
- The settings `slash→dot` re-conversion is **deleted** (pluginId is dot now).

Net: from ~6 scattered ad-hoc regexes to ~4 named calls through one module.
An **object with `id.asPath`** was rejected: the value crosses serialization
boundaries (codegen string literals, JSON API, DB columns, URL params, on-disk
dir names) where it must be a primitive string. A **branded string + helper
functions** gives the same ergonomics, stays serializable, and makes the
dot/slash mix-up a *compile error*.

## The new primitive: `framework/plugins/plugin-id`

`plugins/framework/plugins/plugin-id/` — zero-dependency, build-time-safe, no
React. Importable by web-sdk, server-core, central-core, tooling/codegen,
plugin-tree, config_v2, reorder, plugin-health, boundaries, facets.

- `package.json` — `"singularity": { "description": "Canonical plugin identity: the branded PluginId type and its derived path encodings." }`
- `core/index.ts`:

```ts
/** A plugin's canonical hierarchy id, dot-separated, e.g. "conversations.conversation-view". */
export type PluginId = string & { readonly __brand: "PluginId" };

/** Cast a raw string from a serialization boundary (DB, URL, JSON, codegen literal) to PluginId. */
export const asPluginId = (s: string): PluginId => s as PluginId;

/** Slash form for the config store path: "conversations/conversation-view". NOT the fs path. */
export const asPath = (id: PluginId): string => id.replaceAll(".", "/");

/** Real filesystem path under plugins/: "conversations/plugins/conversation-view". */
export const asFsPath = (id: PluginId): string => id.replaceAll(".", "/plugins/");

/** Segments for breadcrumbs / last-segment matching. */
export const pluginIdSegments = (id: PluginId): string[] => id.split(".");
```

> A `core`-only plugin (no web/server barrel) is valid — `core` is the
> cross-plugin import surface. Mirrors the `rank` / runtime-set primitive
> pattern.

## Changes by area

### 1. Type + helper origin
- **`framework/plugins/web-sdk/core/types.ts`** — delete `export type PluginId = string;`; import `PluginId` from `@plugins/framework/plugins/plugin-id/core`; use it in `Contribution._pluginId` and `LoadedPlugin.id`. Update the "slash-form hierarchy path" JSDoc on `_pluginId` (line 17-20) and `LoadedPlugin` (line 78-86) to "dotted plugin id (e.g. `conversations.conversation-view`)".
- **`framework/plugins/web-sdk/core/index.ts`** — stop re-exporting `PluginId` (no cross-plugin re-exports rule). Repoint any external importer of `PluginId` from web-sdk to `@plugins/framework/plugins/plugin-id/core` (grep first; most consumers use plain `string`).

### 2. Tree (the canonical producer)
- **`plugin-meta/plugins/plugin-tree/core/internal/plugin-tree.ts`** — `PluginNode.hierarchyId` → `id: PluginId`; init at L198 `id: asPluginId("")`; rename `computeHierarchyIds` → `computeIds`, body `node.id = asPluginId(parentId ? \`${parentId}.${node.name}\` : node.name)` (L219).
- **`plugin-meta/plugins/plugin-view/core/types.ts`** — API `PluginNode.hierarchyId` → `id: PluginId`; update comment.
- **`plugin-meta/plugins/plugin-view/server/internal/tree-handler.ts:27`** — `hierarchyId: node.hierarchyId` → `id: node.id`.

### 3. Generated registry + 3 loaders (`hierarchyPath` → `id`, emit dot)
- **`framework/plugins/tooling/plugins/collected-dir/core/load-collected-dir.ts:14`** — shared `CollectedEntry`: rename field `hierarchyPath` → `id`.
- **`framework/plugins/tooling/plugins/codegen/core/plugin-registry-gen.ts`** — `CollectedRawEntry.hierarchyPath` → `id` (L112-116); **L137 emit `id: node.id`** (delete `split(".").join("/")`); emitted interface + render template (L233-248) field rename.
- **`framework/plugins/web-sdk/core/loader.ts`** — interface field `hierarchyPath?` → `id` (L5); `const id = asPluginId(entry.id)` (L31, drop the `?? entry.pluginPath` slash fallback — wrong encoding now; keep dup-guard); `plugin.id = id` (L39).
- **`framework/plugins/server-core/bin/index.ts:29-36`** — `e.hierarchyPath` → `e.id`; `plugin.id = asPluginId(e.id)`.
- **`framework/plugins/central-core/bin/index.ts:22-29`** — same as server.
- Generated files (`web.generated.ts`, `server.generated.ts`, central's) regenerate via build — **do not hand-edit**. `pluginPath` stays (it is the codegen-time fs path used for import specifiers / `dependsOn`).

### 4. config_v2 (one conversion boundary; on-disk layout unchanged)
- **`config_v2/server/internal/registry.ts:245`** — `const pluginId = asPath(asPluginId(contribution.pluginId ?? contribution._pluginId))`. This is the single server boundary: dot id → slash path, stored as the descriptor's `hierarchyPath` via `registerDescriptorPath` (L254). Everything downstream (L197-232, scope-fork, resource.ts, scope-paths.ts `userScopedDir`) keeps reading the slash `hierarchyPath` unchanged.
- **`config_v2/web/internal/store-path.ts`** — `storePluginId` returns the dot `PluginId`; `storePathOf` builds the path with `asPath`: `` `${asPath(id)}/${name}.jsonc` ``. Keeps the client resource key === server storePath. Update the "slash-form" comment.
- **`config_v2/web/internal/use-config-registrations.ts:24`** — `pluginId: c._pluginId` now dot (type `PluginId`).
- **`config_v2/server/internal/contribution.ts`** — `pluginId?` override field comment → "dotted plugin id; lands under `config/<asPath(pluginId)>/`".
- **`config_v2/plugins/settings/web/components/config-nav.tsx`** — delete `hierarchyIdOf = reg.pluginId.split("/").join(".")`; use `reg.pluginId` directly (already dot, matches `node.id`).
- **`config_v2/plugins/settings/web/internal/prune-config-tree.ts`** — map now keyed by `node.id`, built straight from `reg.pluginId`; update the slash→dot comment.

### 5. codegen: config-origin + reorderable-slots
- **`framework/plugins/tooling/plugins/codegen/core/config-origin-gen.ts:60-68`** — override is dot now; `const id = explicit ? asPluginId(explicit) : node.id; results.push({ hierarchyPath: asPath(id), descriptor })` (config files stay slash, via helper).
- **`framework/plugins/tooling/plugins/codegen/core/reorderable-slots-gen.ts:78`** — `definingPath.set(slot.slotId, node.id)` (emit **dot**, delete `replace(/\./g,"/")`); `ReorderableSlotEntry.pluginId` now dot; L88-91 `entryKey` uses dot `c.pluginId` (unchanged code).

### 6. reorder (entryKey form changes — see Caveat)
- **`reorder/shared/reorderable-slots.generated.ts`** — regenerates with dot `pluginId` (no hand-edit).
- **`reorder/web/internal/config-registrations.ts`** + server counterpart — `pluginId: e.pluginId` now dot (no code change).
- **`reorder/web/internal/sorting.ts:42`** — `entryKey` = `` `${item._pluginId}:${id}` `` now produces dot keys (`conversations.conversation-view:foo`).

### 7. Remaining `node.hierarchyId` readers → `node.id`
- **boundaries** `framework/plugins/tooling/plugins/boundaries/core/resolve.ts:39-40` — `${z.name}.${node.id}`; map keyed by `node.id`.
- **facets render-catalog** (~10 `*.tsx` under `apps/plugins/forge/plugins/catalog/.../render-catalog`) — `row.plugin.hierarchyId` → `row.plugin.id`; rename `PluginChip` prop `hierarchyId` → `pluginId` (it is a reference passed to a pane) and its callers; `db-schema-facet-table.tsx:67` `pluginId: r.plugin.id`.
- **plugin-view** `web/panes.tsx` — keep `:pluginId` segment (now correctly a `PluginId`); map keyed by `n.id`; `indexed.get(pluginId)`. `web/components/plugin-detail.tsx:22` — `pluginIdSegments(node.id)`. `plugins/sub-plugins/web/components/sub-plugins-section.tsx:72` — `{ pluginId: node.id }`.
- **active-data plugin-link** `web/components/plugin-link-chip.tsx` — `index.byId.set(node.id, node)`, `pluginIdSegments(node.id).pop()`, `resolvedId = node.id`; `web/panes.tsx:54` map keyed by `node.id`.
- **plugin-health** `server/internal/staleness.ts` — delete `pluginIdToPath`; callers use `asFsPath(asPluginId(pluginId))`. `web/components/health-section.tsx:43,61` — `node.id` (value still dot, no DB migration). `core/schemas.ts` / `mcp-tools.ts` — `pluginId` stays dot.
- **review** `review/plugins/plugin-changes/core/protocol.ts:15` — `hierarchyId` → `pluginId` (DTO referencing a plugin); update sort/usage.
- **forge/publish** `web/components/plugin-tree.tsx`, `publish-view.tsx` — `node.hierarchyId` → `node.id`; pane opens pass `pluginId: node.id`.
- **forge/catalog tables** `plugins/tables/web/panes.tsx` `:pluginId` param holds dot (sections ignore it) — no behavioral change.

## Caveat — reorder ordering reset (one-time)

`entryKey` changes from slash (`a/b:id`) to dot (`a.b:id`). Persisted reorder
`order`/`hidden` arrays keyed by the old slash form will no longer match and
that slot's ordering resets to default. Mitigation checklist during
implementation:
1. `rg -l "order|hidden" config/**/*.jsonc` — for any **committed** reorder
   directive, replace `/`→`.` in the `<pluginId>:<id>` keys (the slot-owner
   portion only).
2. User-scope local config (`~/.singularity/config/`) is not committed; accept a
   one-time visual reorder reset there, or run the same key migration.

No other persisted data changes: the config **store path** stays slash, the
plugin-health `plugin_id` column already stores dot.

## Critical files

- New: `plugins/framework/plugins/plugin-id/core/index.ts`, `.../package.json`
- `plugins/framework/plugins/web-sdk/core/{types.ts,index.ts,loader.ts}`
- `plugins/framework/plugins/{server-core,central-core}/bin/index.ts`
- `plugins/framework/plugins/tooling/plugins/collected-dir/core/load-collected-dir.ts`
- `plugins/framework/plugins/tooling/plugins/codegen/core/{plugin-registry-gen,config-origin-gen,reorderable-slots-gen}.ts`
- `plugins/plugin-meta/plugins/plugin-tree/core/internal/plugin-tree.ts`
- `plugins/plugin-meta/plugins/plugin-view/**` (core/types, server/tree-handler, web/panes + components + sub-plugins)
- `plugins/plugin-meta/plugins/plugin-health/{server/internal/staleness.ts,web/components/health-section.tsx}`
- `plugins/config_v2/server/internal/{registry.ts,contribution.ts}`, `plugins/config_v2/web/internal/{store-path.ts,use-config-registrations.ts}`, `plugins/config_v2/plugins/settings/web/{components/config-nav.tsx,internal/prune-config-tree.ts}`
- `plugins/reorder/web/internal/sorting.ts`
- `plugins/framework/plugins/tooling/plugins/boundaries/core/resolve.ts`
- facets render-catalog tsx (×~10) + `PluginChip`; `plugins/review/plugins/plugin-changes/core/protocol.ts`; forge/publish web; active-data/plugin-link web

## Verification

1. `./equin build` — regenerates `web.generated.ts`, `server.generated.ts`, central registry, `reorderable-slots.generated.ts`, and `config/**.origin.jsonc`. A green build proves the `id`-field rename + dot emission are internally consistent across all three runtimes.
2. `./equin check` — must pass: `plugins-registry-in-sync`, `config-origins-in-sync` (proves on-disk slash layout unchanged), `plugin-boundaries` (proves the new primitive's imports are legal and web-sdk no longer re-exports `PluginId`), `eslint`, `migrations-in-sync`.
3. Spot-grep: `rg -n "hierarchyId|hierarchyPath" plugins -g '*.ts' -g '*.tsx' | grep -v generated` should return only config_v2's intentional internal `hierarchyPath` (slash path) variables — no identity uses.
4. Confirm dot emission: `rg '\bid: "' plugins/framework/plugins/web-sdk/core/web.generated.ts | head` shows dotted ids (`active-data.attempt`), and `~/.singularity/config/` dirs are still slash (`config/active-data/conv/...`) — no config migration.
5. Browser E2E via `bun e2e/screenshot.mjs` against `http://<worktree>.localhost:9000`:
   - Open **Forge → a plugin** (plugin-view pane) — the `:pluginId` URL now carries a dotted `PluginId`; detail breadcrumb renders.
   - Open **Settings** (config_v2) — a config section loads/saves a field (proves storePath resource-key parity end-to-end).
   - Toggle **reorder edit mode** and reorder a slot — confirm it persists (with the entryKey caveat in mind).
   - Open **plugin-health** staleness for a nested plugin — confirms `asFsPath` git path.
