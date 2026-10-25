import type { ReactNode } from "react";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Layer } from "@plugins/primitives/plugins/css/plugins/layer/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import {
  RowActions,
  rowActionsAnchor,
} from "@plugins/primitives/plugins/row-actions/web";
import { dataPart, type ItemActionTarget } from "../../core";
import type { ItemActionArms } from "../internal/use-item-action-zones";

/**
 * The row's primary action (zone `"primary"` — Sonata's Play) as a centred
 * box: painted at rest while the action is active, revealed by the row's
 * `row-actions` hover otherwise. `RowActions` keeps a press on it from
 * reaching the row (its click, its drag). The box is click-through
 * wherever no action is live, so it can sit on a click-through ghost.
 *
 * Placed by its caller over the row's thumbnail: the list on a ghost of its
 * row's line ({@link PrimaryOverThumbnail}), the soft table inside the cover
 * cell's frame.
 */
export function PrimaryActionSlot<TRow>({
  primary,
  target,
  className,
}: {
  primary: ItemActionArms<TRow>;
  target: ItemActionTarget<TRow>;
  /** The box's size — the thumbnail's. */
  className?: string;
}): ReactNode {
  return (
    <Center axis="both" className={className} {...dataPart("dv.cover-primary")}>
      {primary.atRest ? (
        // The ghost is click-through; an action painted at rest is live.
        <RowActions pin={null} alwaysVisible className="pointer-events-auto">
          {primary.atRest(target)}
        </RowActions>
      ) : null}
      {primary.revealed ? (
        <RowActions pin={null}>{primary.revealed(target)}</RowActions>
      ) : null}
    </Center>
  );
}

/**
 * A list row's primary action, centred over its thumbnail.
 *
 * It cannot sit INSIDE the thumbnail: the thumbnail is in `Row`'s icon slot,
 * which on an activating row is inside the row's own `<button>`, and a button
 * may not nest one. So it is the row's SIBLING, drawn on a click-through ghost
 * of the row's line — a `Layer` over the row box with the row's own `p-row`
 * padding, holding one thumbnail-sized cell first — so the cell lands on the
 * thumbnail by construction (same padding, same first track, same centring),
 * never by measured offsets. The box both sit in is the `row-actions` hover
 * group, so the reveal answers the same hover as the row's cluster.
 */
export function PrimaryOverThumbnail<TRow>({
  primary,
  row,
  hasChildren,
  children,
}: {
  primary: ItemActionArms<TRow>;
  row: TRow;
  hasChildren: boolean;
  /** The row. */
  children: ReactNode;
}): ReactNode {
  return (
    <div className={rowActionsAnchor}>
      {children}
      <Layer as={Line} decorative className="p-row">
        <PrimaryActionSlot
          primary={primary}
          target={{ row, hasChildren }}
          className={cn("size-cover-thumb", rigidClass())}
        />
      </Layer>
    </div>
  );
}
