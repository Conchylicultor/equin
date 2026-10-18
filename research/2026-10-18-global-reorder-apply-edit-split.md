# Reorder: split "apply a layout" from "edit a layout"

Track: wiki *Mental model → Plugin system → Composition* (block-6b4d4ded…), item
**[Reorder]** (card block-4d5fe127…). Mental model: block-136ef01b…. Predecessors:
`2026-10-15-global-token-usage-closure-edges.md`, `2026-10-17-global-companion-contributions.md`,
`2026-10-18-global-keyed-companions.md`.

## Context

`reorder.slot-middleware` contributes reorder's list and item middleware to `primitives.slot-render`
as **companions**, so every bundle that renders a slot applies the slot's committed layout. That is
correct. But the middleware is `@plugins/reorder/web`, and that barrel statically imports the whole
editing side:

- `dnd-list-middleware.tsx` always renders `<ReorderEditor editMode={false}>`, even at rest. It holds
  every write path (drop, hide, restore, insert, remove, patch), the popover regime, and the
  `InlinePopover` + `RestoreButton` chrome.
- `dnd-item-middleware.tsx` wraps each item in the editor's `SortableReorderItem`.
- The `spacer` and `divider` node types (also companions) render `SpacerReorderItem` /
  `DividerReorderItem` from the editor.
- `ReorderLayoutContext` types its value with dnd-kit's `SortingStrategy`.

The result is `reorder → reorder.editor → primitives.sortable-list → @dnd-kit/*` in every
composition. Yet the only way to turn edit mode on is `reorder.edit-mode` (the switch plus Esc are the
only `setEditMode` callers), and **no app composition selects it**. Only `singularity` (`**`) ships
it, so in every app the editor is dead code.

Applying and editing are two capabilities. Applying is a companion. Editing is an optional feature,
like the element picker, and it should ship only where the edit-layout switch ships.

**Measured caveat (decided: out of scope).** dnd-kit will *not* leave served bundles from this change
alone. `served-baseline` includes `ui.theme-engine.**`, its theme gallery imports
`primitives.data-view`, and data-view imports `primitives.sortable-list` (sort panel, properties
panel, editable view switcher). Sonata also imports it directly. This task removes reorder as a path
to dnd-kit, but dnd-kit is not the target: it is a dependency-free leaf of ~20 KB gzipped, cached
after the first load. What the split removes is our own editing code (the area editor, item chrome,
the popover regime and their imports) from apps that cannot edit, and the false claim in the
closure that `slot-render` needs it. The remaining dnd-kit paths are left alone unless a boot
profile shows them mattering.

## Design

### 1. Capability boundary

| Side | Plugin | Ships | Contains |
|---|---|---|---|
| Apply | `reorder` (via `reorder.slot-middleware`, companion) | wherever slots render | `applyTree`, the stable area frame, item boxes, node rest forms, `useReorderedEntries`, config descriptors, a small pure **area write API** (`materializeTree`, `mapNodeById`, commit to `setConfig`) |
| Edit | `reorder.edit-mode` (existing plugin, scope widened) | only where selected (today `singularity`) | the switch, Esc, and **the area editor**: the drag host, per-item edit chrome, `RestoreButton`/inserts, hide/restore/drop wiring, the regime choice (passthrough / editor-wrap / popover) and its host-width measurement |
| Presentational | `reorder.editor` | edit side, plus `fields.reorder-tree.config` | unchanged role: `ReorderEditor` for the popover list and the Config pane field |

The write API stays on the apply side for one reason: a header's collapse toggle (`onPatch`) is a
write that is live at rest. It is a few pure functions with no dependencies. The edit host receives it
as props; it does not re-implement it.

Keep the name `reorder.edit-mode` and widen its description: "edit mode" *is* the editing capability,
and a rename would churn config paths for nothing.

### 2. The seam: an editor slot, mounted as a sibling

`reorder` gains one slot, `ReorderSlots.AreaEditor`, defined with `defineMountSlot`. It is a
**plain** slot, not a companion slot, because editing is opt-in. `reorder.edit-mode` contributes the
one implementation. The contract is data plus callbacks: the area's `slotId`, the applied
`ReorderState`, the raw `items` tree, `orientation`, the injected layout, the area write API, and
`renderNode` / `renderItem` for the popover's full-list copy.

Today, toggling edit mode never remounts a contribution in a vertical area (decided: keep that). So
the apply frame renders the **same element chain** in both modes, and the editor is mounted **beside**
the items, never above them. This is the `DeferredSortableList` pattern applied one level up:

```
<ReorderAreaContext.Provider>        // apply-owned now (moved out of reorder.editor)
  <ItemBindingProvider>               // dnd-free binding store (§3)
    <AreaChromeProvider>              // reorder's per-area / per-item chrome store (§4)
      {entries}                       // item boxes + node rest/edit forms
      {editMode && <AreaEditor …/>}   // sibling: drag host, chrome registrars, RestoreButton, popover
```

- The editor publishes into stores; item boxes read from them. No ancestor ever changes type.
- **Horizontal regimes keep today's behaviour**, remount included. The editor publishes `wrap` (the
  frame then renders the flex-wrap div) or `displayOnly` (popover regime: inline items stay bare,
  and the editor renders the trigger plus a popover with its own full `ReorderEditor`). Both
  already remount items today; this change neither improves nor worsens that.
- **Rung 4 assert:** if edit mode is on, the area is reorderable, and no `AreaEditor` contribution is
  registered, the apply middleware throws. That can only happen if something other than the switch
  calls `setEditMode`. Without the throw, edit mode would silently do nothing.

### 3. Split `primitives.sortable-list` along the same line

`deferred-sortable.tsx` already separates the two halves. Only `SortableRegistrar` and the enabled
`<SortableList>` touch dnd-kit. Move the dnd-free half into a child plugin,
`primitives.sortable-list.deferred-item`:

- `createBindingStore`, `ItemBindingProvider` and `DeferredSortableItem`, with no `@dnd-kit` import.

`primitives.sortable-list` keeps the dnd-kit half and composes the child:

- a new `DeferredSortableHost` (registrars inside a `SortableList`, mounted inside a provider);
- `DeferredSortableList`, now `ItemBindingProvider` + children + `enabled && <DeferredSortableHost>`.

Its public behaviour is unchanged for its other users (`fields.list.config`, data-view). The apply
side imports only the child. The edit host mounts `DeferredSortableHost`.

### 4. Item boxes and node types

- **Items.** The at-rest chain of `SortableReorderItem` (`GrowRelay > box > DeferredSortableItem >
  div.contents > children`) becomes an apply-side `ReorderItemBox` in `reorder/web`. Its edit-mode
  extras (ring and cursor classes, `pointer-events-none` content class, the ×-badge, the empty-label
  placeholder, fill columns) come from an `ItemChrome` the edit host publishes per id into the
  per-item chrome store. The chrome is read by id, like drag props.
  - **One chrome computation, two hosts.** `useItemChrome` (with `useIsEmpty` and the fill logic)
    lives in `reorder.editor`.
  - The edit host's per-item registrar publishes it for the in-app area.
  - The editor's own `SortableReorderItem` (popover list, Config field) is `ReorderItemBox` plus a
    local registrar, so the two can't drift apart.
  - `dnd-item-middleware.tsx` renders `ReorderItemBox`, with the claim logic unchanged.
- **Node types.** Leaves remount on toggle today, and that is fine. The rest forms move out of
  `items.tsx` into their node-type plugins: the spacer's `flex-1` gap and the divider's rule, which
  reads `ReorderAreaContext.orientation` from apply. The edit forms stay in the node type too, since
  they are dnd-free now: `DeferredSortableItem` from the child plugin, a dashed placeholder, and a
  shared `RemoveNodeButton` exported from `reorder.node-types/web`. Remove goes through the existing
  `ReorderNodeRenderProps.onRemove`. Node types stop importing `reorder.editor`.
- **`ReorderLayoutContext`** drops `strategy: SortingStrategy` for closed data, `{ flow: "wrap" }`.
  The edit host maps it to `rectSortingStrategy`. `collapsible-wrap` then no longer imports
  `sortable-list` for this.
- Delete `reorder/web/styles.css` (a comment-only side-effect import).

### 5. Guards

- **Rung 3, a check: `reorder:apply-is-lean`** (`plugins/reorder/check/`). It resolves the hard
  closure of `{ entryPoints: ["primitives.slot-render"] }` using the `composition-closure` recipe
  (`buildRegistryGenContext` → `resolveComposition`). It fails if that closure contains
  `reorder.editor`, `reorder.edit-mode` or `primitives.sortable-list`, and prints
  `explainInclusion`. This catches the next convenience import that would drag editing back in.
- **Rung 4:** the missing-editor throw from §2.
- **Existing:** `companions-visible` still sees the slot-middleware and node-type companions;
  `plugin-boundaries` and `boundary-rules` hold the new child plugin to the import grammar.

### Critical files

- `plugins/reorder/web/index.ts`, `web/internal/{dnd-list-middleware,dnd-item-middleware,reorder-layout}.tsx`
  are split into apply frame, item box, write API and the slot.
- `plugins/reorder/plugins/edit-mode/web/` gains `internal/area-editor.tsx` (drag host, regimes,
  registrars, `RestoreButton`) and the `ReorderSlots.AreaEditor` contribution.
- `plugins/reorder/plugins/editor/web/internal/items.tsx`: `useItemChrome`; `SortableReorderItem`
  becomes box plus registrar; the spacer, divider and `RemoveNodeButton` bodies move out.
- `plugins/reorder/plugins/node-types/plugins/{spacer,divider}/web/internal/node-type.tsx`, plus a
  new `node-types/web` export of `RemoveNodeButton`.
- `plugins/primitives/plugins/sortable-list/web/internal/deferred-sortable.tsx` becomes the new
  child `plugins/primitives/plugins/sortable-list/plugins/deferred-item/` plus `DeferredSortableHost`.
- `plugins/primitives/plugins/collapsible-wrap/web/internal/collapsible-wrap.tsx` switches to
  `{ flow: "wrap" }`.
- Docs: `plugins/reorder/CLAUDE.md` (Architecture, Edit mode, regimes), `sortable-list/CLAUDE.md`, and
  the `served-baseline` comment in `plugin-meta/composition/core/config.ts` (reorder "apply").

## Verification

1. **Closure diff.** A one-off `./singularity run` script, using the `composition-closure` recipe,
   resolves every committed composition on `main` and on the branch and prints additions and removals.
   - Expected: `reorder.editor` is removed from every app composition, and `singularity` is
     unchanged.
   - Expected: `primitives.sortable-list` stays wherever data-view ships. Record these numbers on the
     track.
2. **`./singularity check reorder:apply-is-lean`** passes. Temporarily re-adding the editor import
   to `dnd-list-middleware.tsx` must make it fail with the inclusion path.
3. **`./singularity test plugins/reorder plugins/primitives/plugins/sortable-list plugins/fields/plugins/reorder-tree`**,
   including:
   - the existing `item-claim` and `deferred-sortable` no-remount tests;
   - a new jsdom test: a slot contribution's mount count stays the same across `setEditMode(true/false)`
     in a vertical area with the edit plugin registered;
   - a new jsdom test: the missing-editor throw.
4. **`./singularity build`**, then on the worktree app:
   - Run `reorder/e2e/claim-verify.ts`, `reorder/plugins/node-types/e2e/container-members.ts` and
     `primitives/plugins/pane/e2e/header-reorder.ts`.
   - With `browser_*`: toggle edit mode, drag in a sidebar (vertical), and drag in a wide toolbar
     (editor-wrap).
   - Narrow the toolbar to get the popover regime.
   - Hide and restore an item, add and remove a spacer and a divider, and collapse a header at rest.
5. **Wiki.**
   - Tick **[Reorder]** on the track card and update its status, with the closure numbers.
   - Rewrite the mental model's *Not in scope* paragraph.
   - File the next task (**[Guard]**) with the page id.

## Outcome (implemented)

Changes from the design above, found while building it:

- **`reorder.area` (new leaf library).** The editor could not import
  `reorder/web`: `reorder` imports `fields.reorder-tree.config` (for
  `normalizeNode`), which imports `reorder.editor` — a cycle
  (`plugin-boundaries`). What an area *draws* (`ReorderAreaContext`,
  `ReorderItemBox`, the entry and item-chrome types) moved to
  `plugins/reorder/plugins/area`, imported by both sides. `reorder/web` keeps
  the editor contract (`ReorderSlots.AreaEditor`, `ReorderAreaEditorProps`,
  writes, regime).
- **Item chrome is a component, not a per-item registrar.** `ReorderItemBox`
  mounts the area's `ItemChrome` ahead of its content (a sibling) while
  editable; the chrome runs its own hooks (emptiness, missing-`fill` warning)
  and publishes `{ box, content }` classes into the box via a layout effect.
  No area-wide chrome store was needed.
- **`reorder:apply-is-lean` guards `reorder.editor` + `reorder.edit-mode`
  only.** `primitives.sortable-list` still reaches `primitives.slot-render`'s
  closure through `reorder → config_v2 → fields.list.config` (the Config pane's
  list field renderer) — a second dnd-kit route besides data-view, unrelated
  to layout editing.
- The missing-editor throw has no jsdom test (it needs a real config
  descriptor behind the list middleware); the no-remount test lives in
  `reorder/edit-mode/web/__tests__/toggle-no-remount.test.tsx`.

### Closure diff (every committed composition, before → after)

| Composition | Plugins | Removed | Added |
|---|---|---|---|
| every app (agent-manager, home, pages, settings, studio, sonata, debug, deploy, file-explorer, website) and every subsystem/pack except `fields` | unchanged count | `reorder.editor` | `primitives.sortable-list.deferred-item` |
| `fields` | 276 → 277 | — | `deferred-item` (keeps the editor: the reorder-tree Config field uses it) |
| `singularity` (main, `**`) | 1420 → 1421 | — | `deferred-item` (keeps the editor and `reorder.edit-mode`) |

(`reorder.area` is not in the table: the diff was taken before it was split out;
it is a new plugin every composition gains alongside `reorder`.)

`primitives.sortable-list` (dnd-kit) is still in every composition, via data-view
(`ui.theme-engine.theme-gallery`) and `config_v2 → fields.list.config`.
