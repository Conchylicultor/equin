# Reorder → config_v2 integration

## Context

Today the `reorder` plugin stores slot layout (item order + hidden) in its own
Postgres tables (`reorder_prefs`, plus the unused `groups` tables), keyed
per-worktree by `(slotId, contributionId)`. That storage is **invisible and
uneditable to agents** — the `query_db` MCP tool rejects mutations, so an agent
cannot change a toolbar's layout, and there is no way to ship a **default
layout** checked into git.

`config_v2` already solves both: it stores typed config as **JSONC files on
disk** that agents edit directly, with a tier model (code defaults → git-checked
`config/<plugin>/…` → user override) so defaults propagate to every worktree.

This plan migrates reorder's order/hidden state out of the DB and into config_v2,
so that (1) agents edit slot layout by editing files, and (2) default layouts are
committable to git. The in-app drag UX (edit-mode pen) is **preserved** — it just
writes to the config file instead of the DB.

### Key design decisions (settled in discussion)

- **Per-slot config, generic schema.** Each reorderable render-slot gets one
  config_v2 descriptor with an identical schema — a *directive*:
  `{ order: string[]; hidden: string[] }` of `entryKey` strings
  (`"${_pluginId}:${id}"`, the key reorder already uses in
  `plugins/reorder/web/internal/sorting.ts`).
- **Override = directive over the LIVE catalog, not a materialized list.** At
  render, the middleware applies the directive to the live
  `ctx.bySlot.get(slotId)`: `order` items first (in that order), `hidden` items
  removed, unmentioned items keep natural runtime order and are appended. This is
  drift-tolerant — new contributions append, removed ones are ignored — so a
  changing catalog never breaks a saved layout.
- **Stable hash.** Descriptor default = empty directive `{ order: [], hidden: [] }`.
  config_v2 hashes parsed JSON (comments stripped — verified in
  `plugins/config_v2/core/internal/config-proxy.ts` `computeHash`), so the hash is
  stable across catalog changes and config_v2's whole-document staleness never
  invalidates a layout.
- **Catalog = JSONC comments in the generated origin.** The generated
  `<slotId>.origin.jsonc` lists, as comments, every contribution available in the
  slot (`entryKey` + label) — the "what can be reordered" list the agent reads.
  Comments don't affect the hash, so regenerating the catalog each build is free.
- **web↔server bridge = a generated manifest.** The live server can't see web-slot
  contributions, but build-time codegen can (the facets/`barrel-import` path
  docgen already uses). Codegen emits a pure-data manifest of reorderable slots
  (`{ slotId, hierarchyPath }`) importable from both runtimes; reorder registers
  one descriptor per slot on each side from it.
- **Files live under the *defining* plugin** → `config/<defining-plugin>/<slotId>.jsonc`.
- **Scope:** groups stay DB-backed and untouched (follow-up). **Start fresh** —
  drop `reorder_prefs`, no migration. **Defer spacers.** **Minimal** settings-pane
  renderer (in-app drag is the real editor).

---

## Implementation steps

### 1. New field type: `stringListField`
`plugins/config_v2/plugins/fields/plugins/string-list/` (mirror `primitives/text`).
- `core/internal/string-list.ts`:
  `stringListFieldType = defineFieldType<string[]>("string-list")`;
  `stringListField(opts?: FieldMeta & { default?: string[] })` →
  schema `z.array(z.string())`, default `[]`.
- `web/components/string-list-renderer.tsx` + `web/index.ts`:
  `Fields.Renderer(StringListRenderer)` with `.type = stringListFieldType`.
  **Minimal** read-only / textarea renderer.
- Rationale: `listField` injects per-item `id`/`rank` objects
  (`config_v2/server/internal/registry.ts` `injectCollectionIds`) which would
  pollute the directive and churn hashes — a bare string array passes through
  untouched.

### 2. Generic per-slot descriptor factory
`plugins/reorder/shared/directive.ts` (imported by both web & server — isomorphic
core imports only):
```ts
export interface ReorderDirective { order: string[]; hidden: string[]; }
export function reorderDirectiveDescriptor(slotId: string) {
  return defineConfig({ name: slotId, fields: {
    order:  stringListField({ label: "Order",  default: [] }),
    hidden: stringListField({ label: "Hidden", default: [] }),
  }});
}
```
`useConfig` matches descriptor by reference, so each runtime must build descriptors
**once** from the manifest and reuse those instances for both registration and
reads.

### 3. Extend the slots facet to see render slots + `reorder` flag
`plugins/plugin-meta/plugins/facets/plugins/slots/`:
- `core/types.ts`: add `kind?: "render"|"dispatch"|"slot"` and `reorder?: boolean`
  to `SlotDef`.
- `facet/index.ts`: also parse `defineRenderSlot(id, { reorder?: false })` (static
  parse of `web/slots.ts`; default `reorder:true`). Confirm coverage with
  `rg "defineRenderSlot" plugins -l`; runtime `isSlotLike` fallback already catches
  render slots defined elsewhere (loses the flag → defaults true).

### 4. Generate the reorderable-slots manifest at build
- New `plugins/framework/plugins/tooling/plugins/codegen/core/reorderable-slots-gen.ts`
  exported from codegen `core/index.ts`. Walk the enriched plugin tree
  (`buildEnrichedTree`, already cached by docgen), read the slots facet per node,
  filter to render slots with `reorder !== false`, emit:
  ```ts
  export interface ReorderableSlot { slotId: string; hierarchyPath: string; }
  export const reorderableSlots: ReorderableSlot[] = [ … ];
  ```
  `hierarchyPath` = owning `node.hierarchyId.replace(/\./g, "/")` (the **defining**
  plugin).
- Output to `plugins/reorder/shared/reorderable-slots.generated.ts`
  (`// DO NOT EDIT` header), importable as `@plugins/reorder/shared/…`.
- Wire into `plugins/framework/plugins/cli/bin/commands/build.ts`: new step right
  after `generatePluginDocs`, **before** `generateConfigOrigins` (descriptors must
  exist before origins generate). Add a profiler span.
- Add a `reorderable-slots-in-sync` check (mirror `plugins-registry-in-sync`) so
  drift fails the build.

### 5. Catalog → origin comments (general, reusable hook)
- Catalog source: the **contributions facet**
  (`facets/plugins/contributions/facet/index.ts`) already extracts per-slot
  `{ _slotId, _doc.label }`; extend it to also capture `id` + `_pluginId` (to
  compute `entryKey`), or compute the catalog directly in the manifest generator
  from the imported modules. Label = `docLabel`-derived `_doc.label`, falling back
  to `entryKey`.
- General hook in
  `plugins/framework/plugins/tooling/plugins/codegen/core/config-origin-gen.ts`:
  add an optional `originAnnotations?: (descriptor, hierarchyPath) => string[]` to
  `renderConfigOriginContent` / `generateConfigOrigins`; `renderOriginJsonc`
  appends the returned `// …` lines. Default (no provider) → byte-identical output.
- reorder exports a codegen-importable `reorderOriginAnnotations(descriptor, path)`
  returning catalog comment lines for render-slot descriptors and `[]` otherwise.
  Pass it into **both** `generateConfigOrigins` (build) **and** the
  `config-origins-in-sync` check (it compares full origin text, so it must inject
  the identical comments).

### 6. Read path — apply directive to the live catalog
- `plugins/reorder/web/internal/sorting.ts`: replace
  `computeReorderState(contributions, rankMap, groupsData)` with
  `applyDirective(contributions, directive)`:
  partition by `entryKey ∈ directive.hidden` (never hide `excludeFromReorder`);
  sort visible by index in `directive.order` (mentioned first, in order), then
  unmentioned in natural order; keep `excludeFromReorder` pinned last; keep the
  groups membership construction unchanged (groups stay DB-backed).
- `plugins/reorder/web/internal/dnd-list-middleware.tsx`: replace
  `useResource(reorderPrefsResource, { slotId })` with `useConfig(descriptor)`,
  where `descriptor` comes from a module-load `Map<slotId, descriptor>` built from
  `reorderableSlots.map(reorderDirectiveDescriptor)`. Slot not in the map (e.g.
  `reorder:false`) → fall back to natural order (no reorder).
  - **Behavior change (caveat):** `storageId = slotId[:subId]` collapses to
    `slotId` for config — sub-instances of a slot now share one directive. subIds
    aren't known at build. Acceptable; note in CLAUDE.md.

### 7. Write path — mutate the directive
Use `useSetConfig(descriptor)` (POSTs to `/api/config-v2/set-field`); reuses
config_v2's document/hash/conflict/watcher machinery and push-based live update
(replaces `reorderPrefsResource.notify`).
- Drag-reorder → compute new `order` (full visible ordering as `entryKey[]`) →
  `setConfig("order", newOrder)`. This removes the `Rank.between` dance for the
  prefs path (groups still use Rank).
- Hide → `setConfig("hidden", [...hidden, key])`; show →
  `setConfig("hidden", hidden.filter(k => k !== key))`.

### 8. Register descriptors on both runtimes
Loops live in internal modules (barrel purity), spread into `contributions`.
- **Server** `plugins/reorder/server/index.ts` ← `server/internal/config-registrations.ts`:
  `reorderableSlots.map(s => ConfigV2.Register({ descriptor: reorderDirectiveDescriptor(s.slotId), hierarchyPath: s.hierarchyPath }))`.
- **Web** `plugins/reorder/web/index.ts`: same, with `ConfigV2.WebRegister`, reusing
  the SAME descriptor instances as step 6.
- **Required general extension:** add optional `hierarchyPath` to the
  `ConfigV2.Register`/`WebRegister` payloads
  (`config_v2/server/internal/contribution.ts`, `web/internal/slots.ts`) and prefer
  `hierarchyPath ?? _hierarchyPath` in `registry.ts`, `discoverConfigs`
  (`config-origin-gen.ts`), `use-config.ts`, `use-set-config.ts`,
  `use-config-registrations.ts`. This is what plants files under the **defining**
  plugin instead of under `reorder`.

### 9. Delete old storage (start fresh)
- `plugins/reorder/server/internal/tables.ts` (`_reorderPrefs`) + its `schema.ts` /
  `index.ts` re-exports.
- `plugins/reorder/server/internal/resource.ts` (`reorderPrefsResource`) + its
  `Resource.Declare` + export.
- `plugins/reorder/server/internal/handlers.ts` + the `httpRoutes` block.
- `plugins/reorder/shared/resource.ts`, `shared/endpoints.ts`; prune `shared/index.ts`.
- Dead imports in `dnd-list-middleware.tsx` (`reorderPrefsResource`, `Rank` if now
  unused).
- Verified no external consumers; `groups` sub-plugin untouched.
- Migration: dropping `tables.ts` makes drizzle-kit emit `DROP TABLE reorder_prefs`
  via `./equin build` migration generation — standard path, no manual SQL.

### 10. Docs
Update `plugins/reorder/CLAUDE.md` (storage/architecture + the subId and
spacers-deferred caveats). Autogen block refreshes on build.

---

## Critical files
- `plugins/reorder/web/internal/dnd-list-middleware.tsx` — read+write swap
- `plugins/reorder/web/internal/sorting.ts` — directive apply
- `plugins/reorder/shared/directive.ts` (new) + `reorderable-slots.generated.ts` (new)
- `plugins/reorder/server/index.ts` + `server/internal/config-registrations.ts` (new)
- `plugins/config_v2/plugins/fields/plugins/string-list/**` (new)
- `plugins/config_v2/server/internal/{contribution,registry}.ts`,
  `web/internal/{slots,use-config,use-set-config,use-config-registrations}.ts`
  — optional `hierarchyPath`
- `plugins/framework/plugins/tooling/plugins/codegen/core/{config-origin-gen,reorderable-slots-gen,index}.ts`
- `plugins/plugin-meta/plugins/facets/plugins/slots/{core/types.ts,facet/index.ts}`
  and `…/contributions/facet/index.ts`
- `plugins/framework/plugins/cli/bin/commands/build.ts` — wire codegen step

---

## Verification

1. `./equin build` succeeds; generates `reorderable-slots.generated.ts`,
   the `DROP TABLE reorder_prefs` migration, and `config/<plugin>/<slot>.origin.jsonc`
   files. `./equin check` passes (`config-origins-in-sync`,
   `reorderable-slots-in-sync`, `migrations-in-sync`, boundaries).
2. Inspect a generated origin, e.g. `config/shell/shell.toolbar.origin.jsonc`:
   content is `{ order: [], hidden: [] }`; comments list the slot's contributions
   (`entryKey` + label).
3. **Agent-edit path:** create the override `config/shell/shell.toolbar.jsonc`
   (copy origin, keep `// @hash`, set `order`/`hidden`), `./equin build`,
   load `http://<worktree>.localhost:9000` — toolbar reflects the new order/hidden.
4. **In-app drag path:** `bun e2e/screenshot.mjs` — toggle edit-mode pen, drag a
   toolbar item, confirm the change persists (reload) and that
   `config/shell/shell.toolbar.jsonc` now contains the directive. Hide an item via
   edit mode; confirm it lands in `hidden` and disappears.
5. **Drift tolerance:** with a saved override, add/remove a contribution in a slot,
   rebuild — saved items keep their order, the new item appends, the override is
   NOT invalidated (hash stable).
6. Confirm `query_db "SELECT * FROM reorder_prefs"` now errors (table dropped) and
   the groups tables still exist.
