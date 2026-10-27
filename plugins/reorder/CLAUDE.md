# reorder

Generic reorder primitive integrated into `RenderSlot.Render` via a list middleware. Every `defineRenderSlot()` is automatically and unconditionally reorderable — there is no opt-out flag. A slot that should *not* be reorderable is a headless slot: declare it with `defineMountSlot()` (its contributions render nothing, so order is meaningless) — mount slots are absent from the reorder manifest. Persists slot layout as a **config_v2 `items` tree** (JSONC files on disk, agent-editable, committable to git). A layout is edited in that file or in the Config pane's reorder-tree field; there is no in-app drag mode (removed: it cost every slot item app-wide ~10 wrapper fibers to keep its toggle remount-free — `research/2026-10-24-global-slot-item-wrapper-cost.md`).

## Public API (web)

`useReorderedEntries` + `isNodeData` (see below), `entryKey`, `contributionLabel`
and the entry types. What the layout EDITOR draws — `ReorderAreaContext`,
`ReorderItemBox`, the entry and item-chrome types — is the leaf `reorder/area`.

Hosts just use `<MySlot.Render>{(item) => ...}</MySlot.Render>` — the reorder list middleware handles ordering, hiding and registry-driven node types (spacers, dividers, header and overflow groups) automatically. No configuration needed.

### `useReorderedEntries` — data-level layout read

```ts
import { useReorderedEntries, isNodeData } from "@plugins/reorder/web";

const { entries, hidden } = useReorderedEntries("my.slot", contributions);
```

The data-level counterpart to `<Slot.Render>` for consumers that draw their **own** rows (e.g. a menu that reads the slot's contributions directly instead of rendering it). It reads the slot's config tree and applies it over `contributions` — the exact `useReorderTree` + `applyTree` machinery the list middleware uses — and returns the same `ReorderState` (`entries` in layout order + a `hidden` bucket), with **no rendering and no node-type registry**. Hosts branch on entry shape via `isNodeData`, read a header's label off `payload.label`, and respect hidden contributions (routed to `state.hidden`, never surfaced). Throws for a non-reorderable `slotId` (fail loud). Exports the entry types too: `TopLevelEntry`, `ReorderNodeData`, `ReorderState`.

`useLayoutOrder` is its flat form for the common case — the slot's contributions in layout order, hidden ones and layout nodes dropped, a header's members in its place — contributed by `reorder/slot-middleware` as `SlotRender.Order`, which slot-render's `useSlotOrder(slot)` reads, so a host names slot-render, never reorder. **This replaces per-contribution priority numbers**: a host that draws its own rows orders them by this, never by an `order` field (`defineSlot` rejects a numeric one).

`id` is the **stable identifier** for a contribution in a slot. The layout tree references contributions by `entryKey` — `pluginId:id` (computed by `entryKey()`), which prevents collisions when different plugins contribute the same `id` to the same slot. Never rename `id` — renaming orphans the entry in any saved layout (an orphaned name in the tree is skipped on read and the live contribution falls back to natural-order append, so nothing disappears). The rename also shifts the origin `@hash`, so a committed layout is caught — marked for review on build, push blocked until the item is placed again (see *Staleness / reconciliation*); only a user-layer layout loses its customization silently.

## Rules for plugins using reorder

- **Position is a node, not a slot.** To push some of a slot's items to the far end of its row, put a `{ "type": "spacer", "id": "…" }` node before them in the slot's order file — never define a second slot rendered beside the first (`spacer/no-split-slot-row` flags two slots sharing one row). Every committed order file carries the node forms in a build-maintained `// @legend` block (`overrideLegend` on the directive descriptor), so the answer is in the file you edit.
- All `RenderSlot` contributions must provide `id: string` (enforced by the type).
- Hosts use `<Slot.Render>`, not `slot.useContributions()`.
- `excludeFromReorder: true` opts a single contribution out: pinned last, never hidden.

## Architecture — apply here, edit in config

- **Applying** a committed layout is this plugin. Its list middleware is a
  companion of `slot-render` (via `reorder/slot-middleware`), so it ships
  wherever slots render. It never wraps a contribution — there is no item
  middleware — and imports no drag code.
- **Editing** one is the Config pane's `reorder-tree` field over
  `reorder/editor` (dnd-kit). `reorder:apply-is-lean` fails if `slot-render`'s
  closure reaches the editor.

**`ReorderListMiddleware`** (list, priority 0) runs on every render slot,
several per list row, so it pays only for what a slot's layout uses: no
descriptor (runtime-only render slot or an unresolved id) → natural order; a
layout of items only → one config read (`useReorderTree`) + `applyTree()` + a
keyed list; a layout with nodes → also the node registry, the writes a header's
collapse toggle makes (`area-writes.ts`: `patchNode`, `removeNode`), and the
host's measured flow (a divider's rule stands upright in a row — `orientation`
on the node's render props).

### Shared presentational editor (`plugins/editor`)

`<ReorderEditor>` is a self-contained area (its own `DeferredSortableList`, area
context and item chrome) behind the `reorder-tree` field in the Config pane. It
knows nothing about config_v2, the live catalog or the `ReorderTree` format.

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

The tree is **applied over the live catalog** at render (`applyTree()` in `web/internal/sorting.ts`) via `normalizeNode`: named items emit in tree order, hidden items route to the hidden bucket, container members resolve and are **consumed** (so they don't re-emit at top level), unknown names are skipped, and **any live, visible contribution not named in the tree is appended in natural order** — a silent runtime safety net (no error, no log), so a contribution never disappears. It is not what forces placement: that is the build/push step in *Staleness / reconciliation* (a new contribution shifts the origin `@hash` → the committed layout is marked for review and push fails until the item is placed). `excludeFromReorder` items stay pinned last. Both consumers (this middleware and the config-pane field renderer) pre-render each node via `useReorderNodeTypes()` and hand the editor opaque `node` content.

### Materialized origin (not a sparse patch)

Unlike the old drift-tolerant directive (empty default, stable hash), the generated origin's `items` default is the **full current catalog** — every contribution's `entryKey` in natural order (bare strings). The catalog is materialized at build time by `setDefaultOriginDefaultsPreparer` in `reorderable-slots-gen.ts`, so the origin's `@hash` reflects the live catalog. **Adding/removing a contribution shifts the hash**, marking committed overrides stale — the config file is the authoritative layout, not a sparse patch over a live list. See "Staleness / reconciliation" below.

Files land under the **defining** plugin: `config/<defining-plugin>/<slotId>.jsonc` (override) and `<slotId>.origin.jsonc` (generated default; its `items` array is the materialized catalog, and a slim comment legend maps each `entryKey` → label). Agents edit layout by editing these files; defaults are committable to git and propagate to every worktree. See [`authoring-overrides.md`](./authoring-overrides.md) for the rules (ordering, when to add a spacer, when to hide).

The directive descriptor sets config_v2's `requiresAuthoredOverride`, so **`./equin build` seeds a missing override** from its origin (real hash, full catalog) and stamps a `// @review` marker into it — but only for a slot that HAS contributions (`seedWhen`): an `items: []` directive orders nothing, so seeding it would demand a rubber-stamp review. The descriptor is still registered for an empty slot (an existing override must never be pruned), and the first build after the slot gains a contribution seeds it — and re-marks + re-stamps an existing override whose origin hash shifted. The generic `config:overrides-authored` check (`plugins/config_v2/check/`) fails while any marker is present, echoing the descriptor's own guidance lines out of the file. So the obligation is *review*, not presence: deleting a required override just gets it re-seeded, marked, on the next build. The old bespoke `reorder:configs-authored` presence check and its grandfather list are gone.

### web↔server bridge

The live server can't see web-slot contributions, so build-time codegen emits `shared/reorderable-slots.generated.ts` (`{ slotId, pluginId }[]`) from the slots facet. reorder registers one descriptor per slot on **both** runtimes from this manifest:

- web: `ConfigV2.WebRegister` (in `web/internal/config-registrations.ts`)
- server: `ConfigV2.Register` (in `server/internal/config-registrations.ts`)

both with the slot's `pluginId` so the file lands under the defining plugin. `useConfig`/`useSetConfig` match descriptors by **reference identity**, so the web runtime builds its descriptors once in `web/internal/descriptors.ts` and reuses those instances for both registration and reads.

The `reorderable-slots-in-sync` check fails if the manifest drifts; rebuild to regenerate.

### Write path

The Config pane's field writes the whole tree (`setConfig("items", tree)`, the
user layer). The only in-app writes an area makes are its nodes': **patch**
(`onPatch(partial)` shallow-merges into the addressed node's payload — the header
collapse toggle; a hand-authored container without an `id` gets a
`crypto.randomUUID()` on its first write, reads never mutate config) and
**remove**. Changing a committed default means editing
`config/<plugin>/<slot>.jsonc` in a worktree.

### Staleness / reconciliation semantics

Because the origin default is the materialized catalog, adding/removing a contribution shifts the slot's origin `@hash`. Two independent reconciliations, both **existing config_v2 behavior** (no bespoke logic):

- **Code ↔ git override** (`config/<plugin>/<slot>.jsonc`): a committed override whose `@hash` no longer matches the regenerated origin **hard-fails `config-origins-in-sync`**, which runs on `push` → push is blocked until an agent reconciles (edit the committed file to place the new item explicitly — the regenerated origin shows the full current list — and re-stamp the hash). This is the agent-facing forcing function.
- **User override ↔ git** (`~/.equin/state/config/<wt>/.../<slot>.jsonc`): on hash conflict, `effective()` reverts to the origin (natural order) at runtime; the user sees the conflict in the config settings UI and fixes it manually. No `effective()` bypass.
- During the stale window, `applyTree` still appends any unmentioned live contribution (a silent safety net, not a signal) so nothing disappears.

### Caveats

- **subId collapses to slot scope.** The config layout is keyed by the base `slotId` only — subIds aren't known at build. Sub-instances of one render slot therefore **share a single layout**. Intended.
- **Per-row reorderable slots need no wrapper.** A reorderable slot rendered once per row in a list (e.g. `JsonlRowActions.Item` per message row) subscribes per render site, but the underlying config subscription is **shared and kept alive at the live-state layer** (one cache entry + one kept-alive WS sub across all rows). No manual hoisting provider is required — just render `<Slot.Render>` per row as usual.
- **Node types are extensible (registry-driven).** Spacer and the `header` container are just the first built-ins; add a node type by dropping a sub-plugin under `plugins/reorder/plugins/node-types/plugins/` that contributes `ReorderNodes.NodeType({ …, companion: true })` (a companion: a committed layout may name any node type, so each ships wherever the registry does) — no edits to the core format, the editor, or the consumers. Agents hand-author nodes via the `{ "type": … }` shapes shown in each origin file's comment legend.
- **Groups (containers) are authored in the JSONC.** The only in-app container write is toggling a header's `collapsed`.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Generic reorder primitive: every defineRenderSlot is unconditionally reorderable; use defineMountSlot for headless slots. Applies each slot's committed layout everywhere slots render; editing a layout (drag, hide, insert) is the opt-in ReorderSlots.AreaEditor, mounted beside an area's items only while edit mode is on. Generic reorder primitive: per-slot config_v2 directives for contribution order/visibility.
- Load-bearing: yes
- Web:
  - Slots: `ReorderSlots.AreaEditor`
  - Slot contributors: `ReorderSlots.AreaEditor` ← `reorder.edit-mode`
  - Contributes: 262 contributions — full list in [REFERENCE.md](./REFERENCE.md)
    - `ConfigV2.WebRegister` ×262
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
    - `useLayoutOrder`
    - `useReorderedEntries`
- Server:
  - Contributes: 261 contributions — full list in [REFERENCE.md](./REFERENCE.md)
    - `ConfigV2.Register` ×261
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
