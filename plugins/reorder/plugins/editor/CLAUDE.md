# editor

The **presentational** drag-and-drop reorder editor, shared by two consumers:

1. **`reorder`'s list middleware** (`ReorderListMiddleware`) — wired to config_v2
   `setConfig("items", …)` over the live contribution catalog.
2. **The `reorder-tree` field renderer**
   (`fields/reorder-tree/plugins/config/web`) — wired to the field's `onChange`,
   operating directly on the saved `ReorderTree`. This is what makes the Config
   settings pane a full drag editor.

It is deliberately **display-only**: it knows nothing about config_v2, the live
catalog, the `ReorderTree` format, or any specific node type. Each consumer
pre-renders its node types via the node-type registry and maps its own data into
`entries` + callbacks. Because it imports **neither `reorder/web` nor the
`reorder-tree` field**, the field plugin can import it without forming a
`reorder ↔ reorder-tree` cycle.

## API

```tsx
import { ReorderEditor } from "@plugins/reorder/plugins/editor/web";

<ReorderEditor
  entries={entries}            // (item | node) in display order — `node` is opaque
  hiddenItems={hiddenItems}    // { key, label }[] for the restore popover
  onDrop={…} onHide={…} onRestore={…}
  inserts={[{ label, onInsert }]}   // registry-driven insert affordances (e.g. "Add Spacer")
  onRemoveNode={(id) => …}          // remove a node by id (e.g. a spacer's × button)
  editMode={…} orientation="vertical" strategy={…} wrap={…} renderOverlay={…}
/>
```

### `wrap` — editor-owned flex-wrap container

`wrap` (default `false`) renders the sortable cells inside an owned
`flex flex-1 flex-wrap` container so a horizontal row wraps onto multiple lines
instead of overflowing. Pair it with `strategy={rectSortingStrategy}` for correct
2-D drag. Use it ONLY when the host does **not** already own wrapping — never with
a `CollapsibleWrap` host, whose child-measurement would break on an interposed
wrapper div. The `reorder` list middleware sets it only in the "editor-wrap"
regime (see `reorder`'s CLAUDE.md). Default (`false`) renders the cells bare, so
the CollapsibleWrap-host and plain-row paths are byte-for-byte unchanged.

### Two opaque entry kinds

`ReorderEntry` is `item | node`. An `item` carries a pre-rendered contribution
`node` (the middleware wraps it via `ReorderItemMiddleware` → `SortableReorderItem`;
the field renderer wraps a label chip). A `node` entry carries opaque
pre-rendered content for any registered node type, plus optional `memberIds` for
containers (so the shared `SortableContext` registers the child ids; a container
pushes only its members, never its own id — it isn't top-level draggable). The
editor renders both opaquely and knows nothing about spacers, headers, etc.
`SortableReorderItem` and `SpacerReorderItem` are exported so node-type plugins
and consumers wrap with the same draggable primitive.

### `fill` — bounding a height-filling contribution

`SortableReorderItem` takes a `fill?: boolean` prop (default `false`). A non-fill
row sizes to its content; the edit-mode chrome leaves its layout untouched. A
**fill** contribution wants to consume its host column's remaining height and
scroll internally (an inner `flex-1 min-h-0` region — e.g. the conversations
sidebar section). For those, `fill` makes the edit-mode wrapper a bounded flex
column at **both** levels (the outer item box and the inner content wrapper) so
the scroll region clamps instead of expanding to its natural height and
overflowing onto the rows below. The `reorder` list middleware maps it from the
contribution's `fill: true` field; the field renderer never fills.

`fill` is a **slot-level layout role, not a reorder detail** — it is declared on
the render-slot contribution and `slot-render`'s own per-contribution cell reads
it too. Reorder is one of two readers, which is why the field is named `fill`
rather than `reorderFill`.

Here it is always the **block** axis. The INLINE grow — a row cell that expands
instead of shrink-wrapping — is not declared at all any more: the widget that
needs it asks ([`grow-relay`](../../../primitives/plugins/css/plugins/grow-relay/CLAUDE.md)),
and the edit-mode item box and its content wrapper relay the ask like the slot
cell above them, so a bar inside a contribution keeps its width while the pen is
on. Merging the two would turn that bar into a flex column.

In a **column** host a forgotten `fill` is invisible in normal mode (the wrapper
is `display:contents`, so the child participates in its host column directly) and
only breaks in edit mode — a silent, mode-specific footgun. `SortableReorderItem`
therefore detects it after mount: if the contribution's root box declares
`flex-grow` but `fill` is false, it logs a one-time `console.error` naming the
contribution and pointing at `fill: true`. A relayed inline ask is the OTHER
explanation for that same `flex-grow`, and silences it — otherwise the error
would send an author to add the flag that breaks their bar.

### `editMode` is a prop, not a signal

The editor must not depend on `reorder`, so the global `useEditMode()` signal is
**not** read here — the consumer threads `editMode` in (middleware passes
`useEditMode()`; the field renderer passes `true`). `orientation` is likewise a
prop (middleware auto-detects; field is always `"vertical"`).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Presentational drag-and-drop reorder editor: sortable items, hide/restore, spacers and dividers, optional grouping zones. Display-only — no config_v2, catalog, or tree-format knowledge.
- Web:
  - Uses:
    - `primitives/css/grow-relay.GrowRelay`
    - `primitives/css/inline.Inline`
    - `primitives/css/pin.Pin`
    - `primitives/css/row.Row`
    - `primitives/css/spacing.Stack`
    - `primitives/css/text.Text`
    - `primitives/css/ui-kit.Button`
    - `primitives/css/ui-kit.cn`
    - `primitives/css/ui-kit.ControlSize`
    - `primitives/css/ui-kit.ControlSizeProvider`
    - `primitives/css/ui-kit.Input`
    - `primitives/css/ui-kit.useControlSize`
    - `primitives/overlay/popover.InlinePopover`
    - `primitives/sortable-list.DeferredSortableItem`
    - `primitives/sortable-list.DeferredSortableList`
    - `ui/icons.Icon`
  - Exports (types):
    - `ReorderAreaCtxValue`
    - `ReorderEditorProps`
    - `ReorderEntry`
    - `ReorderItemEntry`
    - `ReorderNodeEntry`
  - Exports (values):
    - `DividerReorderItem`
    - `ReorderAreaContext`
    - `ReorderEditor`
    - `RestoreButton`
    - `SortableReorderItem`
    - `SpacerReorderItem`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --border`
    - `ui/tokens/color-palette --destructive`
    - `ui/tokens/color-palette --destructive-foreground`
    - `ui/tokens/color-palette --muted-foreground`
    - `ui/tokens/color-palette --primary`
    - `ui/tokens/density --chrome-pad-x`
    - `ui/tokens/density --control-height-sm`
    - `ui/tokens/density --space-2xs`
    - `ui/tokens/density --space-md`
    - `ui/tokens/density --space-sm`
    - `ui/tokens/density --space-xs`
    - `ui/tokens/shape --radius`
    - `ui/tokens/shape --spacing`
    - `ui/tokens/type-scale --font-scale`
    - `ui/tokens/type-scale --font-size-3xs`
    - `ui/tokens/type-scale --font-size-caption`
    - `ui/tokens/type-scale --font-weight-normal`
    - `ui/tokens/type-scale --line-height-3xs`
    - `ui/tokens/type-scale --line-height-caption`
  - Imported by:
    - `fields/reorder-tree/config`
    - `reorder`
    - `reorder/node-types/divider`
    - `reorder/node-types/spacer`
- Exemptions:
  - Exempts itself from: `data-view/no-adhoc-row-list` — `.` (sanctioned)

<!-- AUTOGENERATED:END -->
