import type { ReactNode } from "react";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import {
  DROP_TARGET_RING,
  useIsBackgroundDropTarget,
  type RowDnd,
  type SectionEnds,
} from "../internal/row-dnd";

/**
 * A view's empty space as a drop target (`rowDrop.background`): the box around
 * one section's rows (`group`; `null` ungrouped), so a drop between them, below
 * them or on a row that does not accept it lands here, highlighted while it
 * would — ringed for a drop into the view; under `placement: "between"` the
 * gap above the first row or after the last (see `RowDnd.backgroundProps`).
 * Without a background drop, its children as they are — no box.
 */
export function DropBackground({
  dnd,
  group,
  firstKey,
  lastKey,
  children,
}: {
  dnd: RowDnd<unknown> | null;
  group: string | null;
  children: ReactNode;
} & SectionEnds): ReactNode {
  const over = useIsBackgroundDropTarget(dnd, group);
  const handlers = dnd?.backgroundProps(group, { firstKey, lastKey });
  if (!handlers) return children;
  const between = dnd?.placement === "between";
  return (
    <div
      {...handlers}
      className={cn(
        "relative rounded-md",
        over && !between && DROP_TARGET_RING,
      )}
    >
      {children}
      {over && between ? <DropInsertLine at="after" /> : null}
    </div>
  );
}

/**
 * Where a `placement: "between"` drop goes: the insertion line on the top
 * (`before`) or bottom (`after`) edge of the nearest `relative` box — a row,
 * or a section's band — drawn as the tree's sibling drop line.
 */
export function DropInsertLine({ at }: { at: "before" | "after" }): ReactNode {
  return (
    <Pin
      to={at === "before" ? "top" : "bottom"}
      spanOffset="xs"
      decorative
      className="bg-primary h-[2px] rounded-full"
    />
  );
}
