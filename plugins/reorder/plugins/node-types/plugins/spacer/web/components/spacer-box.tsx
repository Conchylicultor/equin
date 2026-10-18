import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { DeferredSortableItem } from "@plugins/primitives/plugins/sortable-list/plugins/deferred-item/web";
import { RemoveNodeButton } from "@plugins/reorder/plugins/node-types/web";

// A spacer renders as a flex gap. In edit mode it becomes a draggable, dashed
// placeholder with a delete button. The draggable form is only a box an editor's
// drag host binds (`DeferredSortableItem`) — no drag code ships with it.
export function SpacerBox({
  itemKey,
  editMode,
  onRemove,
}: {
  itemKey: string;
  editMode: boolean;
  onRemove: () => void;
}) {
  if (!editMode) {
    // A spacer is a flex-grow gap that absorbs the slack between siblings.
    // `data-slack-claim` tells a row that would otherwise hand its slack to a
    // default claimant (an adaptive bar's growing title) that the author placed
    // it here instead — two claimants would split it and strand what sits
    // between them in the middle of the row.
    // eslint-disable-next-line layout/no-adhoc-layout -- flex-grow spacer gap absorbing slack between slot contributions
    return <div data-slack-claim="" className="flex-1" />;
  }

  return (
    // The sortable item's wrapper inherits the spacer's flex-grow role so the
    // draggable placeholder still absorbs slack like the live gap it replaces.
    // eslint-disable-next-line layout/no-adhoc-layout -- flex-grow spacer placeholder absorbing slack
    <DeferredSortableItem id={itemKey} className="flex-1">
      {({ isDragging }) => (
        // The draggable dashed spacer placeholder: a flex-grow, centered box
        // carrying drag chrome (cursor-grab, dashed ring).
        <div
          // eslint-disable-next-line layout/no-adhoc-layout -- draggable flex-grow spacer placeholder with drag chrome
          className={cn(
            "group relative flex control-min-sm min-w-8 flex-1 cursor-grab items-center justify-center rounded-md border border-dashed border-muted-foreground/40 px-sm",
            isDragging && "opacity-40",
          )}
        >
          <span className="text-3xs text-muted-foreground/60 select-none">
            ⇔
          </span>
          <RemoveNodeButton label="Remove spacer" onRemove={onRemove} />
        </div>
      )}
    </DeferredSortableItem>
  );
}
