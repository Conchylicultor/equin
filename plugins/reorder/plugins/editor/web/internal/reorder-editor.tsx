import { Fragment, useMemo } from "react";
import { DeferredSortableList } from "@plugins/primitives/plugins/sortable-list/web";
import {
  ReorderAreaContext,
  RestoreButton,
  type ReorderAreaCtxValue,
} from "./items";
import type { ReorderEditorProps } from "./types";

/**
 * Presentational drag-and-drop reorder editor. Owns the `SortableList`, the move
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
  strategy,
  wrap = false,
  renderOverlay,
}: ReorderEditorProps) {
  const sortableIds = useMemo(() => {
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
  }, [entries]);

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
    }),
    [orientation, onHide, onRemoveNode],
  );

  // The sortable cells + trailing restore button, shared by the bare and
  // wrap-container renders so dnd registration is identical in both. Every entry
  // (item or node) carries opaque pre-rendered content — the editor never builds
  // node UI (spacers/containers arrive already rendered via the registry).
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
        strategy={strategy}
      >
        {wrap ? (
          // Editor-owned wrap container: a single honest flex parent of the
          // sortable cells, so a horizontal row wraps instead of overflowing.
          // `SortableContext` registers items by id regardless of DOM nesting,
          // so one extra div is invisible to dnd-kit. Kept as one raw flex
          // parent (fill + wrap + align-content) that dnd-kit measures directly.
          // eslint-disable-next-line layout/no-adhoc-layout -- editor-owned flex-wrap fill container; single honest flex parent dnd-kit measures
          <div className="flex flex-1 flex-wrap content-start items-start gap-xs min-w-0">
            {itemNodes}
          </div>
        ) : (
          itemNodes
        )}
      </DeferredSortableList>
    </ReorderAreaContext.Provider>
  );
}
