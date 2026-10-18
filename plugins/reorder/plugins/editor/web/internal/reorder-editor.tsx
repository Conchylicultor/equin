import { Fragment, useMemo } from "react";
import { DeferredSortableList } from "@plugins/primitives/plugins/sortable-list/web";
import {
  ReorderAreaContext,
  type ReorderAreaCtxValue,
  type ReorderEntry,
} from "@plugins/reorder/plugins/area/web";
import { ReorderItemChrome, RestoreButton } from "./items";
import type { ReorderEditorProps } from "./types";

/**
 * The sortable ids of an area's entries: each item (unless pinned) and leaf
 * node by its own id, a container by its members' (it is not itself draggable).
 */
export function sortableIdsOf(entries: readonly ReorderEntry[]): string[] {
  const ids: string[] = [];
  for (const e of entries) {
    if (e.kind === "node") {
      if (e.memberIds) ids.push(...e.memberIds);
      else ids.push(e.id);
    } else if (!e.excluded) {
      ids.push(e.id);
    }
  }
  return ids;
}

/**
 * Presentational drag-and-drop reorder editor: a self-contained area (its own
 * list, area context and item chrome) for surfaces that are an editor
 * outright — the Config pane's reorder-tree field and the in-app popover
 * regime. Owns the `SortableList`, the move
 * dispatch, the flat `sortableIds`, the hidden/insert affordances, and the area
 * context. It knows NOTHING about config_v2, the live contribution catalog, the
 * node-type registry, or the `ReorderTree` storage format — the consumer maps its
 * own data into `entries` + callbacks and renders every node's opaque content.
 */
export function ReorderEditor({
  entries,
  hiddenItems,
  onDrop,
  onHide,
  onRestore,
  inserts,
  onRemoveNode,
  editMode,
  orientation = "vertical",
  renderOverlay,
}: ReorderEditorProps) {
  const sortableIds = useMemo(() => sortableIdsOf(entries), [entries]);

  const handleMove = useMemo(
    () => (activeId: string, overId: string) => {
      onDrop(activeId, overId);
    },
    [onDrop],
  );

  const ctxValue = useMemo<ReorderAreaCtxValue>(
    () => ({
      orientation,
      onHide,
      onRemoveNode,
      ItemChrome: ReorderItemChrome,
    }),
    [orientation, onHide, onRemoveNode],
  );

  // The sortable cells + trailing restore button. Every entry (item or node)
  // carries opaque pre-rendered content — the editor never builds node UI
  // (spacers/containers arrive already rendered via the registry).
  const itemNodes = (
    <>
      {entries.map((e) => (
        <Fragment key={e.id}>{e.node}</Fragment>
      ))}
      {editMode && (
        <RestoreButton
          hiddenItems={hiddenItems}
          inserts={inserts}
          onRestore={onRestore}
        />
      )}
    </>
  );

  return (
    <ReorderAreaContext.Provider value={ctxValue}>
      {/* Deferred: outside edit mode no drag machinery is mounted at all —
          every render slot in the app is a reorder area, several per list row
          — and entering edit mode binds it beside the items, never above
          them, so no contribution remounts on the toggle. */}
      <DeferredSortableList
        items={sortableIds}
        onMove={handleMove}
        overlay={renderOverlay}
        enabled={editMode}
        orientation={orientation}
      >
        {itemNodes}
      </DeferredSortableList>
    </ReorderAreaContext.Provider>
  );
}
