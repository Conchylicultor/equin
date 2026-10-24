# Shared `<ReorderEditor>` — full drag editor for the reorder-tree config field

> Implements section 8 ("Follow-up") of
> `research/2026-06-09-global-reorder-tree-config-field.md`.

## Context

Reorder slot layouts are now stored as a config_v2 `reorder-tree` field (an
`items` tree of `ReorderNode`s). There are two places a user could edit that
layout, but only one works:

- **In-app pen-drag** (`ReorderListMiddleware` on the live app chrome) — the real
  editor. It reads the tree via `useConfig`, applies it over the live catalog
  (`applyTree`), and writes via `setConfig("items", materializeTree(...))`.
- **The Config settings pane** — the `reorder-tree` field renderer
  (`plugins/fields/plugins/reorder-tree/plugins/config/web`) is **minimal and
  read-only**: it lists nodes but can't reorder, hide/restore, or add/remove
  spacers. A user who opens a slot's layout in Config can't actually edit it.

The presentational drag-and-drop list lives entirely inside reorder's middleware
and is welded to its `setConfig` write path. **This plan extracts that
presentational list into a shared `<ReorderEditor>`** consumed by both the
middleware (wired to `setConfig`) and the field renderer (wired to the field's
`onChange`), so the settings pane becomes a full drag editor (reorder,
hide/restore, add/remove spacer) for the `items` tree.

Groups stay **deferred**: the field editor never renders or emits groups; the
middleware keeps its existing DB-backed groups.

## Decisions (settled with user)

- **Home:** a new sub-plugin **`plugins/reorder/plugins/editor/`** under the
  reorder umbrella (not a primitive). It is purely presentational and imports
  **neither** `reorder/web` nor the `reorder-tree` field — so the field plugin
  importing it creates no cycle (see DAG check below). This groups the editor
  semantically with reorder while keeping the graph acyclic.
- **Field labels:** raw `entryKey` strings (mono chip, matching today's
  read-only renderer). The settings pane has no live catalog to resolve friendly
  names; technical-but-unambiguous labels ship the editor now.

### DAG safety

`reorder/plugins/editor/web` imports only `sortable-list`, `popover`, `row`
primitives + `@dnd-kit/core` + app-global `@/components/ui` — never `reorder` or
`reorder-tree`. New cross-plugin edges:

```
reorder/editor            → primitives/{sortable-list,popover,row}   (leaf)
reorder/web               → reorder/editor/web                       (NEW)
fields/reorder-tree/config/web → reorder/editor/web                  (NEW)
```

`reorder/editor` is a sink (no path back to reorder or reorder-tree), so the
pre-existing `reorder → reorder-tree` edge never closes a cycle.
`./equin check plugin-boundaries` must pass.

## The coupling to break

`dnd-components.tsx` is reorder-independent **except** line 10
`import { useEditMode } from "./edit-mode-store"` (used in `SpacerReorderItem`).
The editor must not depend on reorder → **`editMode` becomes a prop** threaded
down (middleware passes `useEditMode()`; field renderer passes `true`).
`orientation` likewise becomes a prop (middleware auto-detects; field is
`"vertical"`).

## New plugin: `plugins/reorder/plugins/editor/`

Files:

- `package.json` — `@singularity/plugin-reorder-editor`, mirror an existing
  sub-plugin's package.json (e.g. `plugins/reorder/plugins/groups/package.json`).
- `web/index.ts` — barrel: `export { ReorderEditor, DRAG_GROUP_PREFIX }` +
  types (`ReorderEntry`, `ReorderItemEntry`, `ReorderSpacerEntry`,
  `ReorderGroupEntry`, `ReorderEditorProps`); `export default { contributions: [] } satisfies PluginDefinition`.
- `web/internal/reorder-editor.tsx` — `<ReorderEditor>` (the `SortableList`
  wrapper + `reorderCollisionDetection` + `handleMove` dispatch + `sortableIds`
  + `ReorderAreaContext.Provider`, moved from `dnd-list-middleware.tsx`).
- `web/internal/items.tsx` — moved from `dnd-components.tsx`:
  `ReorderAreaContext`/`ReorderAreaCtxValue`, `GroupingZone`,
  `SortableReorderItem`, `SpacerReorderItem`, `RestoreButton`.
- `web/internal/types.ts` — the `ReorderEntry` union + `ReorderEditorProps`.
- `CLAUDE.md` — short reference.

### Prop interface (`web/internal/types.ts`)

Purely presentational — no `Contribution`, `ReorderTree`, or config_v2 types.

```ts
import type { ReactNode } from "react";
import type { SortingStrategy } from "@plugins/primitives/plugins/sortable-list/web";

export interface ReorderItemEntry {
  kind: "item";
  id: string;               // dnd sortable id AND the key passed to callbacks (entryKey)
  label: string;            // empty-state / overlay / restore text
  excluded?: boolean;       // excludeFromReorder: pinned, no hide btn, no group zone
  render: ReactNode;        // field → label chip; middleware → live contribution
}
export interface ReorderSpacerEntry { kind: "spacer"; id: string }
export interface ReorderGroupEntry {  // middleware-only; pre-rendered group box
  kind: "group";
  id: string;               // group id (drag id = DRAG_GROUP_PREFIX + id)
  memberIds: string[];      // member sortable ids, for SortableContext registration
  node: ReactNode;          // fully-rendered ReorderGroupBox (members already wrapped)
}
export type ReorderEntry = ReorderItemEntry | ReorderSpacerEntry | ReorderGroupEntry;

export interface ReorderEditorProps {
  entries: ReorderEntry[];
  hiddenItems: Array<{ key: string; label: string }>;
  // core callbacks
  onDrop: (draggedId: string, overId: string) => void;
  onHide: (id: string) => void;
  onRestore: (key: string) => void;
  onAddSpacer: () => void;
  onDeleteSpacer: (id: string) => void;
  // optional group callbacks (middleware only)
  onGroupCreate?: (draggedId: string, targetId: string) => void;
  onGroupJoin?: (draggedId: string, groupId: string) => void;
  onGroupReorder?: (groupId: string, overId: string) => void;
  onAddGroup?: () => void;
  // display
  editMode: boolean;
  orientation?: "horizontal" | "vertical";   // default "vertical"
  strategy?: SortingStrategy;
  renderOverlay?: (activeId: string) => ReactNode;
}
```

### Graceful group degradation

A single flag gates all group behavior:

```ts
const groupsEnabled = !!onGroupCreate || !!onGroupJoin || !!onGroupReorder
  || entries.some((e) => e.kind === "group");
```

- **Collision detection:** pass `collisionDetection={groupsEnabled ? reorderCollisionDetection : undefined}`.
  `SortableList` falls back to `closestCenter` when undefined — so the field
  editor has no group droppables/zones, matching its reality.
- **`GroupingZone`** renders only when `editMode && ctx.groupsEnabled` (thread
  `groupsEnabled` on `ReorderAreaCtxValue`).
- **`RestoreButton`** renders the "Add Group" row only when `onAddGroup` is set.
- **`handleMove`** does the group-prefix / zone-collision dispatch only when
  `groupsEnabled`; otherwise straight to `onDrop`.
- **`DRAG_GROUP_PREFIX = "reorder-drag-group-"`** moves into the editor and is
  **exported**; `group-box.tsx` imports it (replacing its hardcoded literal at
  `group-box.tsx:33`) so the drag-id contract is explicit.

`sortableIds` derives from `entries` inside the editor (group → `memberIds`,
spacer → `id`, item → `id` unless `excluded`).

## Middleware adaptation (`dnd-list-middleware.tsx`)

Keeps all config/catalog/group logic: `materializeTree`, descriptor lookup,
`useConfig`/`useSetConfig`/`items`, `applyTree`, groups `useResource`,
orientation `useLayoutEffect`+sentinel, every ref, and the handlers
`hideItem`/`restoreItem`/`addSpacer`/`deleteSpacer`/`onDrop`/
`onGroupCreate`/`onGroupJoin`/`onGroupReorder`/`addGroup`/`renderOverlay`.

Becomes a mapping layer:

1. Map `state.groupedEntries` → `entries: ReorderEntry[]` (replacing the JSX at
   `dnd-list-middleware.tsx:571-603`): group → `{ kind:"group", id, memberIds, node: <ReorderGroupBox>…</> }`
   with members wrapped here in `SortableReorderItem`/`SpacerReorderItem`
   (imported from `@plugins/reorder/plugins/editor/web`); spacer → `{ kind:"spacer", id }`;
   item → `{ kind:"item", id: entryKey(c), label: contributionLabel(c), excluded, render: renderItem(c) }`.
2. Render `<ReorderEditor entries hiddenItems …callbacks editMode={useEditMode()}
   orientation={orientation} strategy={injected?.strategy} renderOverlay={renderOverlay} />`,
   wiring callbacks to the existing ref-backed handlers. All group callbacks +
   `onAddGroup` are passed → `groupsEnabled` true → behavior identical to today.
   The hidden `sentinelRef` div stays (orientation detection) just before the editor.

`ReorderGroupBox` (`group-box.tsx`) **stays in reorder** (imports group
endpoints) and is injected as the group entry's `node`. `dnd-components.tsx` is
deleted (all symbols moved); `reorderCollisionDetection`/`handleMove`/
`sortableIds`/`DRAG_GROUP_PREFIX`/the `SortableList` render tree leave the
middleware.

## Field-renderer adaptation

`plugins/fields/plugins/reorder-tree/plugins/config/web/components/reorder-tree-renderer.tsx`
becomes a real `FieldRendererComponent<ReorderTree>` using `value` + `onChange`.
New helper file `…/components/tree-ops.tsx` (label-only, no live catalog):

- `treeToEntries(tree)` → `{ entries, hiddenItems }`: `normalizeNode` each node;
  `{item, hidden:false}`/bare string → item entry (`id`/`label` = the entryKey,
  `render` = `<span className="px-2 py-1 font-mono text-sm">{key}</span>`);
  `{item, hidden:true}` → hidden bucket; `{spacer}` → spacer entry (**dedup
  repeated ids** with a `Set` — there's no `applyTree` to dedup here, and dup
  sortable ids break dnd-kit); `{group}` → ignored.
- Tree mutators (each returns a fresh `ReorderTree` for `onChange`, mirroring
  `materializeTree` semantics — visible order first, hidden nodes appended last
  so reorder never un-hides):
  - `reorderTree(tree, draggedId, overId)` — splice the visible (non-hidden item +
    spacer) sequence, re-serialize (bare string for plain visible items,
    `{item,hidden:true}` / `{spacer}` otherwise), append hidden nodes.
  - `hideInTree(tree, key)` — flip the matching visible item node → `{item, hidden:true}`.
  - `restoreInTree(tree, key)` — flip the hidden node → bare string (restored
    in place; harmless divergence from the middleware's re-append-to-end).
  - `addSpacer(tree)` → `[...tree, { spacer: crypto.randomUUID() }]`.
  - `deleteSpacer(tree, id)` → filter the matching `{spacer}` node.

Renderer body:

```tsx
const { entries, hiddenItems } = useMemo(() => treeToEntries(value), [value]);
return (
  <div className="flex flex-col gap-1.5 py-3">
    <FieldHeader field={field} />
    <ReorderEditor
      entries={entries} hiddenItems={hiddenItems}
      onDrop={(a, o) => onChange(reorderTree(value, a, o))}
      onHide={(k) => onChange(hideInTree(value, k))}
      onRestore={(k) => onChange(restoreInTree(value, k))}
      onAddSpacer={() => onChange(addSpacer(value))}
      onDeleteSpacer={(id) => onChange(deleteSpacer(value, id))}
      editMode orientation="vertical"
    />
  </div>
);
```

No group callbacks / `onAddGroup` / `renderOverlay` / `strategy` →
`groupsEnabled` false → plain `closestCenter`, no zones, no "Add Group", no
overlay (optimistic `arrayMove` in `SortableList` + `onChange` re-derive handles
the shift). Drop the old `NodeRows` and the "No items." branch — an empty
`ReorderEditor` shows just the "Add" affordance, a better empty state.

## Critical files

**New** — `plugins/reorder/plugins/editor/`: `package.json`, `web/index.ts`,
`web/internal/reorder-editor.tsx`, `web/internal/items.tsx`,
`web/internal/types.ts`, `CLAUDE.md`.

**Modified:**
- `plugins/reorder/web/internal/dnd-list-middleware.tsx` — mapping layer; remove
  extracted symbols; import `ReorderEditor`/`SortableReorderItem`/
  `SpacerReorderItem` from the editor barrel.
- `plugins/reorder/web/internal/group-box.tsx` — import `DRAG_GROUP_PREFIX` from
  the editor barrel instead of the hardcoded literal (`:33`).
- `plugins/fields/plugins/reorder-tree/plugins/config/web/components/reorder-tree-renderer.tsx`
  — full editor.
- **New** `…/reorder-tree/plugins/config/web/components/tree-ops.tsx` — helpers.

**Deleted:** `plugins/reorder/web/internal/dnd-components.tsx` (symbols moved).

**Unchanged:** `sorting.ts`, `edit-mode-store.ts`, `reorder-layout.tsx`,
`descriptors.ts`, `dnd-item-middleware.tsx`, the storage format / origin codegen.

## Risks / edge cases

- **`SortableReorderItem` empty-content MutationObserver** — harmless for the
  field editor (the `LabelChip` is never empty, so the placeholder never shows).
  Keep as-is; do not special-case.
- **Spacer dedup** — the field path has no `applyTree`; `treeToEntries` must
  dedup spacer ids (`Set`) to avoid duplicate `SortableContext` ids.
- **`dragInProgress`** on `ReorderAreaCtxValue` is dead (set `false`, never read)
  — drop it during the move.
- **`excluded`** is middleware-only; gate the hide button + grouping zone on
  `!excluded`. Field editor never sets it.
- **Group member wrapping** — the editor wraps top-level items; the middleware
  wraps group members (since the group box is injected pre-rendered). Both use
  the same `SortableReorderItem` from the editor barrel, so a member dragged out
  of a group is byte-identical to a top-level item (`entryKey` is the id
  contract).

## Verification

1. `./equin build`; `./equin check plugin-boundaries` (confirms the
   two new edges + DAG); `./equin check` (typecheck/lint). Grep
   `plugins/reorder/plugins/editor` for `@plugins/reorder/web`, `@plugins/fields`,
   `@plugins/config_v2` → must be zero.
2. **Field editor (new):** open a reorderable slot's `items` field in the Config
   settings pane (`bun e2e/screenshot.mjs`). Drag two rows → on-disk
   `~/.singularity/config/.../<slot>.jsonc` `items` reorders (bare strings).
   Hide an item → `{item,hidden:true}` appended, shows in the "N hidden" popover;
   restore → bare string. Add Spacer → `{spacer:<uuid>}`; delete spacer → gone.
   Confirm no "Add Group" and no center grouping zone.
3. **In-app middleware (regression):** toggle the pen; drag-reorder a live
   contribution → persists; floating overlay card still appears; hide/restore +
   add/remove spacer unchanged.
4. **Groups still work in-app:** drag onto center → create group (DB); onto join
   zone → join; drag group header → reorder (`Rank.between`). Confirms
   `groupsEnabled` + injected `ReorderGroupBox` + `DRAG_GROUP_PREFIX` contract.
5. **2-D wrap slot** (collapsible-wrap injects `rectSortingStrategy`) still drags
   — `strategy` threads through.
