import { useMemo, useState } from "react";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { InlinePopover } from "@plugins/primitives/plugins/overlay/plugins/popover/web";
import {
  DeferredSortableHost,
  rectSortingStrategy,
} from "@plugins/primitives/plugins/sortable-list/web";
import {
  ReorderEditor,
  RestoreButton,
  sortableIdsOf,
} from "@plugins/reorder/plugins/editor/web";
import { useReorderNodeTypes } from "@plugins/reorder/plugins/node-types/web";
import {
  contributionLabel,
  entryKey,
  isNodeData,
  type ReorderAreaEditorProps,
} from "@plugins/reorder/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const tuneIcon = symbol("tune");

/**
 * The in-app layout editor for one reorder area, mounted by the area BESIDE its
 * items while edit mode is on (never around them — see `ReorderAreaEditor`).
 *
 * In place (`passthrough` / `editor-wrap` / `host-wrap`): a drag host binding
 * the frame's items and leaf nodes, plus the trailing restore / insert button.
 * `popover`: the frame's inline row stays display-only, and this renders the
 * trigger and a roomy vertical popover holding a whole `ReorderEditor` — the
 * area's only drag surface, so each id is registered once.
 */
export function AreaEditor({
  regime,
  orientation,
  layout,
  entries,
  editEntries,
  state,
  renderItem,
  writes,
}: ReorderAreaEditorProps) {
  const nodeTypes = useReorderNodeTypes();
  const [popoverOpen, setPopoverOpen] = useState(false);

  const hiddenItems = useMemo(
    () =>
      state.hidden.map((c) => ({
        key: entryKey(c),
        label: contributionLabel(c),
      })),
    [state.hidden],
  );

  const inserts = useMemo(() => {
    const out: Array<{ label: string; onInsert: () => void }> = [];
    for (const nt of nodeTypes.values()) {
      const insert = nt.insert;
      if (!insert) continue;
      out.push({
        label: insert.label,
        onInsert: () => writes.insert(insert.create),
      });
    }
    return out;
  }, [nodeTypes, writes]);

  const sortableIds = useMemo(() => sortableIdsOf(entries), [entries]);

  // The drag overlay re-renders the active contribution (catalog-aware); node
  // ids resolve to null (nodes aren't top-level draggable).
  const renderOverlay = (activeId: string) => {
    const entry = state.entries.find(
      (x) => !isNodeData(x) && entryKey(x) === activeId,
    );
    if (!entry || isNodeData(entry)) return null;

    // Fill contributions render a height-filling, internally-scrolling body
    // (e.g. the Conversations sidebar section). Re-rendering that live as the
    // drag overlay produces a tall floating panel — wrong for a "pick up this
    // section" gesture. Show a compact label chip instead, using the human
    // label the slot already exposes via `docLabel` (id fallback). Gated on the
    // same first-class `fill` flag that bounds the edit-mode wrapper, so
    // the primitive stays generic (never reads app-shell's title/icon).
    if ((entry as Record<string, unknown>).fill) {
      const label = entry._doc?.label ?? contributionLabel(entry);
      return (
        <div className="cursor-grabbing rounded-md border border-primary/50 bg-background/95 px-sm py-2xs shadow-lg ring-1 ring-primary/50">
          <Badge variant="primary">{label}</Badge>
        </div>
      );
    }

    // NOT claimed, deliberately: the overlay is a PREVIEW of the dragged
    // contribution, not a member of the area. `DragOverlayWrapper` lives inside
    // the same `DndContext` as the list, so claiming it would register the
    // dragged id a SECOND time for the duration of the drag. Unclaimed, it
    // renders the bare contribution — it loses the item chrome (ring / ×-badge)
    // inside the box below, which is accepted; re-claiming is not the fix if
    // that preview ever looks wrong.
    return (
      <div className="rounded-md border border-border bg-background/90 shadow-lg">
        {renderItem(entry)}
      </div>
    );
  };

  if (regime === "popover") {
    return (
      <InlinePopover
        resetOnClose
        open={popoverOpen}
        onOpenChange={setPopoverOpen}
        tooltip="Edit layout"
        trigger={
          <Button
            variant="ghost"
            aspect="icon"
            aria-label="Edit layout"
            // Stop the pointerdown from reaching an ancestor reorder item's
            // dnd-kit sensor (which would capture the pointer and swallow the
            // popover-trigger click) — same guard the hide/spacer buttons use.
            onPointerDown={(e) => e.stopPropagation()}
            // `pointer-events-auto` re-enables the trigger when this area is
            // nested inside another reorder item, whose edit-mode content
            // wrapper is `pointer-events-none`. The popover content portals to
            // <body>, escaping that trap — so a nested narrow area becomes
            // editable here even though inline drag never was.
            // `shrink-0` keeps this rigid trigger from being crushed in the
            // narrow horizontal reorder band it sits in.
            // eslint-disable-next-line layout/no-adhoc-layout -- rigid popover-trigger leaf in the constrained horizontal reorder band
            className="shrink-0 pointer-events-auto"
          >
            <Icon icon={tuneIcon} className="size-3.5" />
          </Button>
        }
        width="lg"
        padding="xs"
      >
        <ReorderEditor
          entries={editEntries ?? entries}
          hiddenItems={hiddenItems}
          onDrop={writes.drop}
          onHide={writes.hide}
          onRestore={writes.restore}
          inserts={inserts}
          onRemoveNode={writes.removeNode}
          renderOverlay={renderOverlay}
          editMode
          orientation="vertical"
        />
      </InlinePopover>
    );
  }

  // A wrapped row (the frame's own `editor-wrap`, or a layout owner's
  // `flow: "wrap"`) drags in 2-D; a single line uses the orientation's strategy.
  const strategy =
    layout?.flow === "wrap" || regime === "editor-wrap"
      ? rectSortingStrategy
      : undefined;

  return (
    <>
      <DeferredSortableHost
        items={sortableIds}
        onMove={writes.drop}
        overlay={renderOverlay}
        orientation={orientation}
        strategy={strategy}
      />
      <RestoreButton
        hiddenItems={hiddenItems}
        inserts={inserts}
        onRestore={writes.restore}
      />
    </>
  );
}
