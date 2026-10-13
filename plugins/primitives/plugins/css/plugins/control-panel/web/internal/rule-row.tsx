import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import {
  RowActions,
  rowActionsAnchor,
} from "@plugins/primitives/plugins/row-actions/web";
import type React from "react";

import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const closeIcon = symbol("close");
const dragIndicatorIcon = symbol("drag-indicator");

export interface ControlPanelRuleRowProps {
  /** Leading word of the sentence — "Where", "And", "Sort by", "then by". */
  prefix?: React.ReactNode;
  /** The field picker. */
  field: React.ReactNode;
  /**
   * The operator picker. OMIT IT for a builder that has no operator (sort): the
   * field cell then spans the operator's track, so the two builders keep
   * identical rails without leaving a hole mid-row.
   */
  operator?: React.ReactNode;
  /** The value control. */
  value?: React.ReactNode;
  /** Extra controls in the trailing cell, rendered BEFORE the built-in remove. */
  actions?: React.ReactNode;
  /**
   * Paint `actions` at rest instead of on row hover — for a toggle whose ON
   * state is itself information the row must show (a pinned sort rule's pin).
   */
  actionsAtRest?: boolean;
  onRemove?: () => void;
  /** Accessible name for the remove button; default "Remove". */
  removeLabel?: string;
  /** Shows the drag handle in the gutter track (revealed on row hover/focus). */
  handle?: boolean;
  /** dnd-kit listeners/attributes (and an activator `ref`) for that handle. */
  handleProps?: React.HTMLAttributes<HTMLElement> & {
    ref?: React.Ref<HTMLElement>;
  };
  /** Forwarded to the row box — the sort rule list is a dnd-kit sortable. */
  ref?: React.Ref<HTMLDivElement>;
  style?: React.CSSProperties;
  className?: string;
}

const HANDLE_REVEAL =
  "opacity-0 pointer-events-none " +
  "group-hover/cp-rule:opacity-100 group-hover/cp-rule:pointer-events-auto " +
  "group-focus-within/cp-rule:opacity-100 group-focus-within/cp-rule:pointer-events-auto";

/**
 * One line of a builder, on the six-track grid every builder shares — so the
 * field / operator / value columns line up down the list AND across the filter
 * and sort panels.
 *
 * It has NAMED SLOTS AND NO `children`, deliberately. A slot-less escape hatch is
 * exactly how one shared grid degrades into six bespoke ones: the first call site
 * that needs "just one extra thing" writes its own row, and the alignment
 * invariant quietly becomes a convention again. `actions` covers the real case
 * (the filter's "Turn into group") inside the grid rather than beside it.
 *
 * `handleProps` plus `ref`/`style`/`className` forwarding are likewise not
 * niceties: both the sort rule list and the Properties list are dnd-kit
 * sortables, which need the transform style on the row box and the activator on
 * the handle.
 *
 * The row is a non-interactive `<div>`, which is what lets it legally nest the
 * remove button and the pickers its cells hold.
 */
export function ControlPanelRuleRow({
  prefix,
  field,
  operator,
  value,
  actions,
  actionsAtRest = false,
  onRemove,
  removeLabel = "Remove",
  handle,
  handleProps,
  ref,
  style,
  className,
}: ControlPanelRuleRowProps) {
  return (
    <div
      ref={ref}
      style={style}
      data-span={operator != null ? undefined : "field"}
      className={cn(
        "group/cp-rule cp-rule text-body transition-colors hover:bg-hover-fill/50",
        // The row-actions primitive brings its OWN hover group rather than
        // piggybacking on `group/cp-rule`, so the trailing cluster reveals only
        // when this class is on the row it belongs to.
        rowActionsAnchor,
        className,
      )}
    >
      {/* `data-cp-handle` is the occupancy mark `cp-panel` scans for: a builder
          whose rules cannot be reordered reserves no gutter track, and the cell
          is then hidden so it cannot auto-place into the prefix track. */}
      <span
        {...handleProps}
        data-cp-cell="gutter"
        data-cp-handle={handle ? "" : undefined}
        className={cn(
          "flex items-center justify-center text-muted-foreground",
          handle ? cn("cursor-grab", HANDLE_REVEAL) : "pointer-events-none",
          handleProps?.className,
        )}
      >
        {handle ? <Icon icon={dragIndicatorIcon} /> : null}
      </span>
      <span data-cp-cell="prefix" className="truncate text-muted-foreground">
        {prefix}
      </span>
      <span data-cp-cell="field" className="min-w-0">
        {field}
      </span>
      {operator != null ? (
        <span data-cp-cell="operator" className="min-w-0">
          {operator}
        </span>
      ) : null}
      <span data-cp-cell="value" className="min-w-0">
        {value}
      </span>
      {/* Two clusters in the one reserved trailing track — the shape the
          row-actions primitive documents for a table's `auto` grid column.
          `pin={null}` for both: the track already reserves this space, so the
          cluster belongs IN FLOW; pinning it would float it over the value cell
          and paint a `--scrim` this row has no tint to publish.

          They differ on the one axis that is genuinely per-cluster. `actions` is
          contextual and secondary (the filter's "Turn into group"), so it fades
          in on row hover (unless `actionsAtRest` says its state must show —
          a pressed sort-rule pin). The remove ✕ is the builder's own verb — you add and
          drop rules constantly — and the track holds its width either way, so
          hiding it would cost discoverability and buy nothing: it lives at rest.
          The clusters render in that order, so `actions` sits before the ✕.

          `RowActions` also supplies the xs control density and the click /
          pointerdown guards, which is why this cell no longer sets its own. */}
      <span
        data-cp-cell="remove"
        className="flex items-center justify-end gap-2xs"
      >
        {actions ? (
          <RowActions pin={null} alwaysVisible={actionsAtRest}>
            {actions}
          </RowActions>
        ) : null}
        {onRemove ? (
          <RowActions pin={null} alwaysVisible>
            <IconButton
              icon={closeIcon}
              label={removeLabel}
              onClick={onRemove}
            />
          </RowActions>
        ) : null}
      </span>
    </div>
  );
}
