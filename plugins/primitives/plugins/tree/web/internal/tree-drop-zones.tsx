import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import type { RowControls } from "./use-tree-row";

export type TreeDropZonesProps = Pick<
  RowControls,
  "beforeRef" | "afterRef" | "isOverBefore" | "isOverAfter"
>;

/**
 * A tree row's sibling drop zones: a thin strip along its top and bottom edge
 * (dnd-kit droppables registered through `beforeRef` / `afterRef`), each
 * painting the insertion line while a drag hovers it. The reparent (`child`)
 * zone is the row's own box, not drawn here. Must sit inside the row's
 * `relative` box — the strips pin to its edges.
 */
export function TreeDropZones({
  beforeRef,
  afterRef,
  isOverBefore,
  isOverAfter,
}: TreeDropZonesProps) {
  return (
    <>
      <Pin ref={beforeRef} to="top" stretch decorative className="h-[6px]">
        {isOverBefore && (
          <Pin
            to="top"
            spanOffset="xs"
            decorative
            className="bg-primary h-[2px] rounded-full"
          />
        )}
      </Pin>
      <Pin ref={afterRef} to="bottom" stretch decorative className="h-[6px]">
        {isOverAfter && (
          <Pin
            to="bottom"
            spanOffset="xs"
            decorative
            className="bg-primary h-[2px] rounded-full"
          />
        )}
      </Pin>
    </>
  );
}
