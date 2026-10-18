import { useContext, useRef, useState, type ReactNode } from "react";
import { DeferredSortableItem } from "@plugins/primitives/plugins/sortable-list/plugins/deferred-item/web";
import { GrowRelay } from "@plugins/primitives/plugins/css/plugins/grow-relay/web";
import { ReorderAreaContext, type ReorderItemChromeClasses } from "./area";

export interface ReorderItemBoxProps {
  itemKey: string;
  /** Whether this item is editable right now (the effective edit mode). */
  editMode: boolean;
  label: string;
  /**
   * The contribution fills its host's height with an inner `flex-1 min-h-0`
   * scroll region (e.g. the conversations sidebar section): the edit chrome
   * keeps both box levels a bounded flex column so it clamps and scrolls. This
   * is the BLOCK axis — a different question from the inline grow the box also
   * relays (`asked`).
   */
  fill?: boolean;
  children: ReactNode;
}

/**
 * One item of a reorder area: a `DeferredSortableItem` (a drag host bound
 * beside it, when an editor mounts one, makes it draggable) around a content
 * wrapper. At rest both levels are `display: contents`, so the contribution
 * sits in its host as if unwrapped.
 *
 * Editable, it mounts the area's `ItemChrome` AHEAD of the content — a sibling,
 * never a wrapper — and wears the classes the chrome publishes. The element
 * chain down to the contribution is the same in both modes, so toggling edit
 * mode remounts nothing.
 *
 * It sits inside a `GrowRelay`: in edit mode the box and its content wrapper
 * are two more boxes between a contribution's widget and the row, so they relay
 * the widget's inline grow ask like the slot cell above them does.
 */
export function ReorderItemBox(props: ReorderItemBoxProps) {
  return (
    <GrowRelay>{(asked) => <ItemBox {...props} asked={asked} />}</GrowRelay>
  );
}

function ItemBox({
  itemKey,
  editMode,
  label,
  fill = false,
  asked,
  children,
}: ReorderItemBoxProps & { asked: boolean }) {
  const ctx = useContext(ReorderAreaContext);
  const contentRef = useRef<HTMLDivElement>(null);
  const [classes, setClasses] = useState<ReorderItemChromeClasses | null>(null);
  const Chrome = editMode ? (ctx?.ItemChrome ?? null) : null;
  return (
    <DeferredSortableItem id={itemKey} className={classes?.box ?? "contents"}>
      {() => (
        <>
          {Chrome ? (
            <Chrome
              itemKey={itemKey}
              label={label}
              fill={fill}
              asked={asked}
              contentRef={contentRef}
              publish={setClasses}
            />
          ) : null}
          <div ref={contentRef} className={classes?.content ?? "contents"}>
            {children}
          </div>
        </>
      )}
    </DeferredSortableItem>
  );
}
