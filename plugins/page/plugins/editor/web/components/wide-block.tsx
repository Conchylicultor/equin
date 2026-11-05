import type { ReactNode } from "react";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";

import { WIDE_BLOCK_MAX } from "../internal/page-column";

/**
 * A block whose content may be wider than the reading column — a table with
 * many or long columns — grows past the column into the pane's free space,
 * staying CENTERED on the column, while every other block keeps the measure.
 *
 * Its width is its content's own (`max-content`), never less than the column
 * and never more than the surface allows (`WIDE_BLOCK_MAX`, from the width the
 * editor publishes). Past that the content wraps or scrolls inside — what is
 * inside decides which.
 *
 * Centered by a grid's `justify-items: center`: a grid item wider than its
 * track overflows BOTH sides equally, so no transform (which would make this a
 * fixed-position containing block) and no measuring of its own width is needed.
 * `relative` so an overlay pinned to the block (a hover button) pins to the
 * widened box, not to the column under it.
 */
export function WideBlock({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    // eslint-disable-next-line layout/no-adhoc-layout -- a centered grid item is the one way to overflow a column symmetrically without a transform; the ramp has no breakout primitive
    <div className="grid grid-cols-1 justify-items-center">
      <div
        className={cn("relative w-max min-w-full", className)}
        style={{ maxWidth: WIDE_BLOCK_MAX }}
      >
        {children}
      </div>
    </div>
  );
}
