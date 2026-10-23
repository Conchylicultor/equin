# reorder

Generic reorder primitive integrated into `RenderSlot.Render` via middleware. Every `defineRenderSlot()` is automatically and unconditionally reorderable — there is no opt-out flag. A slot that should *not* be reorderable is a headless slot: declare it with `defineMountSlot()` (its contributions render nothing, so order is meaningless) — mount slots are absent from the reorder manifest. DnD is applied through the middleware pipeline. Persists slot layout as a **config_v2 `items` tree** (JSONC files on disk, agent-editable, committable to git); iOS-style edit mode (the "Edit layout" switch in the action bar's gear popover) toggles drag affordances globally.

## Public API (web)

`ReorderLayoutContext` / `ReorderLayout` (host-injected layout for the
middleware, closed data: `{ flow: "wrap" }`), `useReorderedEntries` + `isNodeData`
(see below), the entry types, and the apply/edit seam: `ReorderSlots.AreaEditor`
and the editor contract types. What an area DRAWS — `ReorderAreaContext`,
`ReorderItemBox`, the entry and item-chrome types — is the leaf `reorder/area`,
shared with the editor (which may not import this barrel: `reorder` reaches it
back through `fields/reorder-tree/config`).

**Edit mode is NOT here.** `setEditMode` / `getEditMode` / `useEditMode` live in
the leaf `@plugins/primitives/plugins/edit-mode-signal/web` — reorder consumes
it like everyone else. Read that plugin's CLAUDE.md before moving it back: a
primitive must not take on `reorder/web` just to read a boolean.

Hosts just use `<MySlot.Render>{(item) => ...}</MySlot.Render>` — the reorder list and item middlewares handle sorting, registry-driven node types (spacers, container groups) and, where `reorder/edit-mode` ships, edit-mode affordances automatically. No configuration needed.

### `useReorderedEntries` — data-level layout read

```ts
import { useReorderedEntries, isNodeData } from "@plugins/reorder/web";

const { entries, hidden } = useReorderedEntries("my.slot", contributions);
```

The data-level counterpart to `<Slot.Render>` for consumers that draw their **own** rows (e.g. a menu that reads the slot's contributions directly instead of rendering it). It reads the slot's config tree and applies it over `contributions` — the exact `useReorderTree` + `applyTree` machinery the list middleware uses — and returns the same `ReorderState` (`entries` in layout order + a `hidden` bucket), with **no rendering and no node-type registry**. Hosts branch on entry shape via `isNodeData`, read a header's label off `payload.label`, and respect hidden contributions (routed to `state.hidden`, never surfaced). Throws for a non-reorderable `slotId` (fail loud). Exports the entry types too: `TopLevelEntry`, `ReorderNodeData`, `ReorderState`.

`id` is the **stable identifier** for a contribution in a slot. The layout tree references contributions by `entryKey` — `pluginId:id` (computed by `entryKey()`), which prevents collisions when different plugins contribute the same `id` to the same slot. Never rename `id` — renaming orphans the entry in any saved layout (an orphaned name in the tree is skipped on read and the live contribution falls back to natural-order append, so nothing disappears, but the customization is lost).

## Rules for plugins using reorder

- **Position is a node, not a slot.** To push some of a slot's items to the far end of its row, put a `{ "type": "spacer", "id": "…" }` node before them in the slot's order file — never define a second slot rendered beside the first (`spacer/no-split-slot-row` flags two slots sharing one row). Every committed order file carries the node forms in a build-maintained `// @legend` block (`overrideLegend` on the directive descriptor), so the answer is in the file you edit.
- All `RenderSlot` contributions must provide `id: string` (enforced by the type).
- Hosts use `<Slot.Render>`, not `slot.useContributions()`.
- `excludeFromReorder: true` opts a single contribution out (used by the edit-layout switch itself).

## Architecture — apply here, edit opt-in

Two capabilities, two shipping rules:

- **Applying** a committed layout is this plugin. Its middlewares are companions
  of `slot-render` (via `reorder/slot-middleware`), so they ship wherever slots
  render. It imports no drag code: no `reorder/editor`, no
  `primitives/sortable-list` (only its dnd-free `deferred-item`).
- **Editing** one is `reorder/edit-mode`, opt-in (main's `**` selects it, no app
  does). It contributes the one `ReorderSlots.AreaEditor` — `{ Area, ItemChrome }`
  — together with the Edit layout switch, the only `setEditMode(true)` caller.
  Edit mode with no editor registered throws (`list-middleware.tsx`).
  `reorder:apply-is-lean` fails if `slot-render`'s closure reaches the editor.
  (dnd-kit itself still ships everywhere — `config_v2 → fields/list/config` and
  data-view import `sortable-list` — but no longer because of reorder.)

1. **`ReorderListMiddleware`** (list, priority 0) — reads the slot's `items` tree via `useConfig(descriptor)`, applies it over the live catalog (`applyTree()`), and draws the area's **frame**: `ReorderAreaContext` > `ItemBindingProvider` (`sortable-list/deferred-item`, dnd-free) > the entries (claimed items, node-type nodes) — and, while edit mode is on, `<editor.Area>` **beside** them. No descriptor (runtime-only render slot or an unresolved id) → natural order, nothing applied.
2. **`ReorderItemMiddleware`** (item, priority 50) — wraps each claimed contribution in `ReorderItemBox` (`reorder/area`): a `DeferredSortableItem` around a content wrapper, both `display: contents` at rest. Editable, the box mounts the area's `ItemChrome` **ahead of** its content and wears the classes it publishes (ring, `pointer-events-none`, fill bound).

**Toggling edit mode remounts no contribution (vertical areas).** Nothing an editor adds is an ancestor of a contribution: the drag host (`DeferredSortableHost`) binds the boxes from beside them, the chrome is a sibling of the content. Horizontal areas change shape in edit mode (the `editor-wrap` div, the `popover` regime) and remount there, as they always have. Outside edit mode an area mounts no drag machinery, and the list middleware measures its host only while something reads it — edit mode, or nodes drawn at rest (a divider's upright rule).

The writes (`area-writes.ts`: hide, restore, drop, insert, removeNode, patchNode) live here, not in the editor, because one is live at rest — a header's collapse toggle. The editor receives them as `ReorderAreaEditorProps.writes`. Node types render both their forms themselves (`editMode` prop); the leaf ones' draggable form is a `DeferredSortableItem` the editor's host binds.

### Shared presentational editor (`plugins/editor`)

`<ReorderEditor>` is a self-contained area (its own `DeferredSortableList`, area
context and item chrome) for surfaces that are an editor outright: the
`reorder-tree` field in the Config pane and the in-app `popover` regime. It knows
nothing about config_v2, the live catalog or the `ReorderTree` format. It also
exports `ReorderItemChrome` (the chrome the in-app editor contributes),
`RestoreButton` and `sortableIdsOf`.

## Storage — config_v2 `items` tree (materialized)

Slot layout lives in **config_v2**, not the DB. Each reorderable render slot gets one config_v2 descriptor (`reorderDirectiveDescriptor(slotId)` in `shared/directive.ts`) — a single `items` field of type `reorder-tree` (`@plugins/fields/plugins/reorder-tree`). The value is a **tree** (`ReorderTree = ReorderNode[]`) whose core format reserves only the structural fields; everything else is per-node-type payload:

```ts
type ReorderNode =
  | string                                   // terse: coerces to { item }
  | { item: string; hidden?: boolean }       // entryKey; hidden = remove from slot
  | { type: string; id?: string;             // any registered node type (dispatch by `type`)
      items?: ReorderNode[];                 // structural child-list (containers only)
      [payload: string]: unknown };          // per-type payload, OWNED by the node type
```

- An `item` node names a contribution by `entryKey`. A bare string is the terse form (coerces to `{ item }`). `{ item, hidden: true }` removes it from the slot (never hides `excludeFromReorder` items).
- Every **extension** node is `{ type, … }` — dispatched to the **node-type registry** (`@plugins/reorder/plugins/node-types`). The core format knows only the structural `type`/`id`/`items`; `label`/`collapsed`/etc. are each node type's own payload (validated by its `schema`). Built-ins: `{ type: "spacer", id }` (a blank draggable gap) and `{ type: "header", label?, collapsed?, items: [...] }` (a labeled, collapsible **container**). Containers are **one level — no nesting**.
- An **unknown** `type` (or invalid payload) is skipped at render (fail-soft).

The tree is **applied over the live catalog** at render (`applyTree()` in `web/internal/sorting.ts`) via `normalizeNode`: named items emit in tree order, hidden items route to the hidden bucket, container members resolve and are **consumed** (so they don't re-emit at top level), unknown names are skipped, and **any live, visible contribution not named in the tree is appended in natural order** (fail-loud — a contribution is never silently dropped). `excludeFromReorder` items stay pinned last. Both consumers (this middleware and the config-pane field renderer) pre-render each node via `useReorderNodeTypes()` and hand the editor opaque `node` content.

### Materialized origin (not a sparse patch)

Unlike the old drift-tolerant directive (empty default, stable hash), the generated origin's `items` default is the **full current catalog** — every contribution's `entryKey` in natural order (bare strings). The catalog is materialized at build time by `setDefaultOriginDefaultsPreparer` in `reorderable-slots-gen.ts`, so the origin's `@hash` reflects the live catalog. **Adding/removing a contribution shifts the hash**, marking committed overrides stale — the config file is the authoritative layout, not a sparse patch over a live list. See "Staleness / reconciliation" below.

Files land under the **defining** plugin: `config/<defining-plugin>/<slotId>.jsonc` (override) and `<slotId>.origin.jsonc` (generated default; its `items` array is the materialized catalog, and a slim comment legend maps each `entryKey` → label). Agents edit layout by editing these files; defaults are committable to git and propagate to every worktree. See [`authoring-overrides.md`](./authoring-overrides.md) for the rules (ordering, when to add a spacer, when to hide).

The directive descriptor sets config_v2's `requiresAuthoredOverride`, so **`./singularity build` seeds a missing override** from its origin (real hash, full catalog) and stamps a `// @review` marker into it — but only for a slot that HAS contributions (`seedWhen`): an `items: []` directive orders nothing, so seeding it would demand a rubber-stamp review. The descriptor is still registered for an empty slot (an existing override must never be pruned), and the first build after the slot gains a contribution seeds it — and re-marks + re-stamps an existing override whose origin hash shifted. The generic `config:overrides-authored` check (`plugins/config_v2/check/`) fails while any marker is present, echoing the descriptor's own guidance lines out of the file. So the obligation is *review*, not presence: deleting a required override just gets it re-seeded, marked, on the next build. The old bespoke `reorder:configs-authored` presence check and its grandfather list are gone.

### web↔server bridge

The live server can't see web-slot contributions, so build-time codegen emits `shared/reorderable-slots.generated.ts` (`{ slotId, pluginId }[]`) from the slots facet. reorder registers one descriptor per slot on **both** runtimes from this manifest:

- web: `ConfigV2.WebRegister` (in `web/internal/config-registrations.ts`)
- server: `ConfigV2.Register` (in `server/internal/config-registrations.ts`)

both with the slot's `pluginId` so the file lands under the defining plugin. `useConfig`/`useSetConfig` match descriptors by **reference identity**, so the web runtime builds its descriptors once in `web/internal/descriptors.ts` and reuses those instances for both registration and reads.

The `reorderable-slots-in-sync` check fails if the manifest drifts; rebuild to regenerate.

### Write path

Every edit **materializes** the top-level order into a fresh `items` tree (`materializeTree` in `area-writes.ts`) and `setConfig("items", tree)`. Container subtrees are re-emitted **verbatim** from the raw tree (members/payload preserved) — in-app editing rewrites only the loose top-level items/spacers around them:

- **Drag reorder:** the new top-level order — contributions as bare strings, leaf/container nodes verbatim; the existing hidden set is appended as `{ item, hidden: true }` so a reorder never un-hides.
- **Hide / restore:** materialize, flipping the target to/from `{ item, hidden: true }`.
- **Insert (registry-driven):** node types declaring `insert` (e.g. spacer's "Add Spacer") append `insert.create()`. **Remove:** `onRemoveNode(id)` drops the node by id (top-level or inside a container).
- **Patch:** `onPatch(id, partial)` shallow-merges into the addressed node's payload (e.g. the header collapse toggle). Containers are addressed by `id`; a hand-authored container without one gets a `crypto.randomUUID()` assigned on its first in-app write (reads never mutate config).

config_v2's set-field endpoint + watcher drive the live update across tabs. An
in-app drag writes the **user layer only** (`setConfig("items", tree)`); changing
a committed default means editing `config/<plugin>/<slot>.jsonc` in a worktree.

### Staleness / reconciliation semantics

Because the origin default is the materialized catalog, adding/removing a contribution shifts the slot's origin `@hash`. Two independent reconciliations, both **existing config_v2 behavior** (no bespoke logic):

- **Code ↔ git override** (`config/<plugin>/<slot>.jsonc`): a committed override whose `@hash` no longer matches the regenerated origin **hard-fails `config-origins-in-sync`**, which runs on `push` → push is blocked until an agent reconciles (edit the committed file to place the new item explicitly — the regenerated origin shows the full current list — and re-stamp the hash). This is the agent-facing forcing function.
- **User override ↔ git** (`~/.singularity/state/config/<wt>/.../<slot>.jsonc`): on hash conflict, `effective()` reverts to the origin (natural order) at runtime; the user sees the conflict in the config settings UI and fixes it manually. No `effective()` bypass.
- During the stale window, `applyTree` still appends any unmentioned live contribution (fail-loud) so nothing disappears.

### Caveats

- **subId collapses to slot scope.** The config layout is keyed by the base `slotId` only — subIds aren't known at build. Sub-instances of one render slot therefore **share a single layout**. Intended.
- **Per-row reorderable slots need no wrapper.** A reorderable slot rendered once per row in a list (e.g. `JsonlRowActions.Item` per message row) subscribes per render site, but the underlying config subscription is **shared and kept alive at the live-state layer** (one cache entry + one kept-alive WS sub across all rows). No manual hoisting provider is required — just render `<Slot.Render>` per row as usual.
- **Node types are extensible (registry-driven).** Spacer and the `header` container are just the first built-ins; add a node type by dropping a sub-plugin under `plugins/reorder/plugins/node-types/plugins/` that contributes `ReorderNodes.NodeType({ …, companion: true })` (a companion: a committed layout may name any node type, so each ships wherever the registry does) — no edits to the core format, the editor, or the consumers. Agents hand-author nodes via the `{ "type": … }` shapes shown in each origin file's comment legend.
- **Groups (containers) are config-only this pass.** In-app edit mode reorders loose items/spacers, hides/restores, adds spacers, and toggles a container's `collapsed` — but does **not** create/destroy containers or change their membership/order (author that in the JSONC). Containers are not top-level draggable yet (no drag handle/rank). The old DB-backed `groups` sub-plugin (Postgres tables + `Rank` + endpoints) was **deleted**.

## Edit mode

Module-level signal in `@plugins/primitives/plugins/edit-mode-signal/web` (no React Context). The edit-layout switch (`reorder/edit-mode`) toggles it; middlewares read it via `useSyncExternalStore`. Esc exits edit mode (a registered shortcut in `reorder/edit-mode`).

## Constrained-space regimes (horizontal areas)

Edit mode inflates every item with chrome (ring, ×-badge, empty-item placeholder, trailing `+Add`), which overflows a narrow horizontal band. The list middleware (`list-middleware.tsx`) measures the host width (ResizeObserver + rAF on the sentinel's parent, no timers) and picks a regime:

- **host-wrap** — a `CollapsibleWrap` host already owns wrapping (detected via the injected `ReorderLayoutContext`). Rendered exactly as before; the editor adds no wrapper (an interposed div would break CollapsibleWrap's child-measurement).
- **passthrough** — vertical orientation or not in edit mode. Vertical rows already stack `w-full`; outside edit mode there's no chrome. Unchanged render.
- **editor-wrap** — horizontal, edit mode, width ≥ `POPOVER_WIDTH_THRESHOLD` (280px). The frame wraps items in a `flex-wrap` div and the editor drags with `rectSortingStrategy`. Also the default before the first width measurement (wrapping never overlaps).
- **popover** — horizontal, edit mode, width < threshold. The inline row renders the live contributions **display-only** (clean, not draggable) and the editor renders a `tune` button opening a roomy **vertical** `ReorderEditor` popover hosting the full list (visible + hidden + spacers + groups). The popover is the only drag surface, so each id is registered once.

**Effective edit mode.** The frame always wraps its items in `ReorderEffectiveEditModeContext` (`web/internal/effective-edit-mode.tsx`, internal): `null` → read the global signal; `false` (popover regime) → display-only. The editor is rendered OUTSIDE that provider, so the popover's items read the global `true` and drag normally. All regimes share the same writes — only the dispatching surface differs.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Generic reorder primitive: every defineRenderSlot is unconditionally reorderable; use defineMountSlot for headless slots. Applies each slot's committed layout everywhere slots render; editing a layout (drag, hide, insert) is the opt-in ReorderSlots.AreaEditor, mounted beside an area's items only while edit mode is on. Generic reorder primitive: per-slot config_v2 directives for contribution order/visibility.
- Load-bearing: yes
- Web:
  - Slots: `ReorderSlots.AreaEditor`
  - Slot contributors: `ReorderSlots.AreaEditor` ← `reorder.edit-mode`
  - Contributes: 240 contributions — full list in [REFERENCE.md](./REFERENCE.md)
    - `ConfigV2.WebRegister` ×240
  - Uses:
    - `config_v2.ConfigV2`
    - `config_v2.useConfig`
    - `config_v2.useSetConfig`
    - `primitives/dom/element-size.useResizeObserver`
    - `primitives/dom/layout-host.flowAxis`
    - `primitives/dom/layout-host.layoutHost`
    - `primitives/edit-mode-signal.useEditMode`
    - `primitives/latest-ref.useLatestRef`
    - `primitives/sortable-list/deferred-item.ItemBindingProvider`
    - `reorder/area.ReorderAreaContext`
    - `reorder/area.ReorderAreaCtxValue`
    - `reorder/area.ReorderEntry`
    - `reorder/area.ReorderItemBox`
    - `reorder/node-types.useReorderNodeTypes`
  - Exports (types):
    - `ReorderAreaEditor`
    - `ReorderAreaEditorProps`
    - `ReorderAreaWrites`
    - `ReorderLayout`
    - `ReorderNodeData`
    - `ReorderRegime`
    - `ReorderState`
    - `TopLevelEntry`
  - Exports (values):
    - `contributionLabel`
    - `entryKey`
    - `isNodeData`
    - `ReorderItemMiddleware`
    - `ReorderLayoutContext`
    - `ReorderListMiddleware`
    - `ReorderSlots`
    - `useReorderedEntries`
- Server:
  - Contributes: 239 contributions — full list in [REFERENCE.md](./REFERENCE.md)
    - `ConfigV2.Register` ×239
  - Uses: `config_v2.ConfigV2`
  - Exports (values): `reorderDirectiveDescriptor`
- Cross-plugin:
  - Uses tokens: `ui/tokens/density --space-xs`
  - Imported by:
    - `apps-core/app-launcher`
    - `apps/desktop/launcher`
    - `conversations/conversation-view/artifacts`
    - `page/editor`
    - `primitives/collapsible-wrap`
    - `reorder/edit-mode`
    - `reorder/slot-middleware`
- Shared:
  - Exports (types): `ReorderableSlot`
  - Exports (values):
    - `reorderableSlots`
    - `reorderDirectiveDescriptor`
- Test helpers:
  - Web: `@plugins/reorder/web/testing`
    - `ReorderItemClaim` — Stands in for the list middleware's per-`renderItem` claim, so a test can render `ReorderItemMiddleware` as an item of a hand-built area.
  - Server: `@plugins/reorder/server/testing`
    - `reorderableSlots`
- Sub-plugins:
  - **`area`** — What a reorder area draws, shared by applying a slot layout (reorder) and editing one (reorder/editor, reorder/edit-mode): the area context, the entry types, and ReorderItemBox — an item box at rest…
  - **`edit-mode`** — Slot-layout editing, opt-in: the Edit layout switch in the action bar's view-options popover (Esc exits), and the area editor every reorderable slot mounts beside its items while edit mode is on…
  - **`editor`** — Presentational drag-and-drop reorder editor: a self-contained ReorderEditor (list, hide/restore, inserts), the item chrome that dresses a reorder item box in edit mode, and the restore/insert…
  - **`node-types`** — Reorder node-type registry: owns the reorder.node-type slot and the useReorderNodeTypes() read hook. Slot owner only — contributes no node types itself.
  - **`slot-middleware`** — Applies every render slot's committed layout: reorder's list and item middleware, contributed to slot-render as companions so they ship wherever slots render. Editing a layout is not here — it is…

<!-- AUTOGENERATED:END -->
