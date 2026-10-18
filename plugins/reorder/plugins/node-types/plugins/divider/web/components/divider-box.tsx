import { useContext } from "react";
import {
  cn,
  type ControlSize,
  useControlSize,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { DeferredSortableItem } from "@plugins/primitives/plugins/sortable-list/plugins/deferred-item/web";
import { RemoveNodeButton } from "@plugins/reorder/plugins/node-types/web";
import { ReorderAreaContext } from "@plugins/reorder/plugins/area/web";

// A divider renders as a hairline rule between the items either side of it,
// turned to the area's flow (`ReorderAreaContext.orientation`, which the list
// middleware measures off the host's flex direction):
//
// - **Vertical area** (a sidebar's footer rows): a horizontal rule on the
//   region's rail (`rail-follow`), with a 6px gap above and below.
// - **Horizontal area** (a toolbar, the action bar): an upright 1px rule with
//   the same 6px gap either side, as tall as a little over half the row's
//   controls — derived from the ambient control height (the slot's density), so
//   it scales with the bar instead of being a fixed pixel length.
//
// The 6px is `xs` + `2xs` of the density ramp, so it scales with the density
// preset. In edit mode it becomes a draggable dashed placeholder carrying the
// same rule, with the same delete button as a spacer.
const DIVIDER_GAP = "calc(var(--space-xs) + var(--space-2xs))";

/** The upright rule's length, as a share of the row's control height. */
const UPRIGHT_RULE_SHARE = 0.56;

/** The upright rule's length for the ambient control density. */
function uprightRuleHeight(size: ControlSize): string {
  return `calc(var(--control-height-${size}) * ${UPRIGHT_RULE_SHARE})`;
}

export function DividerBox({
  itemKey,
  editMode,
  onRemove,
}: {
  itemKey: string;
  editMode: boolean;
  onRemove: () => void;
}) {
  const ctx = useContext(ReorderAreaContext);
  const controlSize = useControlSize();
  const upright = ctx?.orientation === "horizontal";

  // The rule itself — the same element in both modes, so the edit-mode
  // placeholder carries exactly what the live divider draws.
  const rule = upright ? (
    <div
      className="border-l border-border"
      style={{ height: uprightRuleHeight(controlSize) }}
    />
  ) : (
    <div className="border-t border-border" />
  );

  if (!editMode) {
    return upright ? (
      <div
        role="separator"
        aria-orientation="vertical"
        style={{ marginInline: DIVIDER_GAP }}
      >
        {rule}
      </div>
    ) : (
      <div
        role="separator"
        className="rail-follow"
        style={{ paddingBlock: DIVIDER_GAP }}
      >
        {rule}
      </div>
    );
  }

  return (
    <DeferredSortableItem id={itemKey}>
      {({ isDragging }) => (
        <div
          className={cn(
            "group relative cursor-grab rounded-md border border-dashed border-muted-foreground/40",
            // The placeholder pads along the flow: around an upright rule it
            // is a narrow box as tall as the rule plus the gap; around a flat
            // one, a full-width band.
            upright ? "py-2xs" : "px-sm",
            isDragging && "opacity-40",
          )}
          style={
            upright
              ? { paddingInline: DIVIDER_GAP }
              : { paddingBlock: DIVIDER_GAP }
          }
        >
          {rule}
          <RemoveNodeButton label="Remove divider" onRemove={onRemove} />
        </div>
      )}
    </DeferredSortableItem>
  );
}
