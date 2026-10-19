import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  RowActions,
  rowActionsAnchor,
} from "@plugins/primitives/plugins/row-actions/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import type React from "react";
import { useId } from "react";

import { Icon } from "@plugins/ui/plugins/icons/web";

import {
  dragIndicatorIcon,
  HANDLE_REVEAL,
  type ControlPanelHandleProps,
} from "./handle";
import { HintedLabelCell } from "./hint";

/**
 * The chrome-gutter stripe. A STATE with two named tones, never a
 * `gutter?: ReactNode` child slot — the slot reopens "the author draws chrome",
 * which is the one thing this vocabulary exists to close.
 *
 * It costs no track, changes no rail and lands identically on a `Setting`, a
 * `Block` header and a `Group` header, because it paints in the gap the row's
 * own bleed already leaves between the panel's inner edge and the row's box —
 * a gap that until now nothing painted in at all.
 */
export type ControlPanelMark = "accent" | "warning";

/** `field` takes the panel's field width; `inline` sizes to its own content. */
export type ControlPanelFit = "inline" | "field";

interface SettingRowProps {
  label: React.ReactNode;
  hint?: string;
  /** The value cell's content. Omitted for a header row that has no control. */
  control?: React.ReactNode;
  fit?: ControlPanelFit;
  status?: React.ReactNode;
  actions?: React.ReactNode;
  mark?: ControlPanelMark;
  /** Shows the drag handle in the gutter (revealed on row hover/focus). */
  handle?: boolean;
  /** dnd-kit listeners/attributes (and an activator `ref`) for that handle. */
  handleProps?: ControlPanelHandleProps;
  disabled?: boolean;
  className?: string;
}

/**
 * The value row's box, shared by `Setting`, `Block`'s header and `Group`'s
 * inline header — because those three ARE one row with different contents, and
 * splitting them into three components is how one shared grid becomes three that
 * drift.
 *
 * The host is ALWAYS a plain `<div>`. That is not a default, it is the
 * construction: `ControlPanelSettingProps` carries no `onSelect` and no `href`,
 * so the row can never become a click target, and a control nested inside its
 * cells is therefore legal here and only here. Same trade `RuleRow` made — the
 * two row families differ on exactly one honest axis, who is the click target,
 * enforced by disjoint prop sets rather than by review.
 *
 * The trailing cluster composes `RowActions` at `pin={null}`, verbatim the
 * `RuleRow` construction: the track already reserves the space, so the cluster
 * belongs IN FLOW; pinning it would float it over the value cell. It borrows
 * that primitive's reveal coupling — a hidden action is never a live hit-target
 * — and its xs density instead of restating either.
 */
export function SettingRow({
  label,
  hint,
  control,
  fit,
  status,
  actions,
  mark,
  handle,
  handleProps,
  disabled,
  className,
}: SettingRowProps) {
  const hintId = useId();
  return (
    <div
      data-cp-mark={mark === "accent" ? "" : mark}
      aria-describedby={hint ? hintId : undefined}
      className={cn(
        "cp-setting text-body",
        "[&_svg:not([class*='size-'])]:icon-auto",
        // The actions cluster brings its OWN hover group rather than
        // piggybacking on this row's, so it reveals only for the row it is in.
        rowActionsAnchor,
        handle && "group/cp-row",
        disabled && "pointer-events-none opacity-50",
        className,
      )}
    >
      {/* The gutter is PADDING on this grid (see `cp-setting`), so the handle is
          hung in it absolutely — at exactly the x a `cp-row`'s gutter cell sits
          at. `data-cp-handle` is the same occupancy mark a `Row` stamps, so the
          panel reserves the gutter for every row in it either way. */}
      {handle ? (
        <span
          {...handleProps}
          data-cp-handle=""
          className={cn(
            "flex cursor-grab items-center justify-center text-muted-foreground",
            HANDLE_REVEAL,
            handleProps?.className,
          )}
        >
          <Icon icon={dragIndicatorIcon} />
        </span>
      ) : null}
      <HintedLabelCell hint={hint} descriptionId={hintId}>
        {label}
      </HintedLabelCell>
      {/* The value cell exists only when there IS a control, and marking it is
          what opens the panel's value track — per PANEL, like every other track
          here, so one field row lines every field control in the panel up while
          a header row with no control costs nothing. */}
      {control != null ? (
        <span data-cp-cell="value" data-cp-value data-cp-fit={fit}>
          {control}
        </span>
      ) : null}
      {status != null ? (
        // PRESENTATIONAL, and deliberately NOT hover-revealed: a tier badge that
        // appears on hover is a badge nobody reads. In flow, before the actions.
        <span
          data-cp-cell="status"
          data-cp-status
          className="flex items-center gap-2xs text-caption text-muted-foreground"
        >
          {status}
        </span>
      ) : null}
      {actions != null ? (
        <span
          data-cp-cell="actions"
          data-cp-actions
          className="flex items-center justify-end"
        >
          <RowActions pin={null}>{actions}</RowActions>
        </span>
      ) : null}
    </div>
  );
}

/**
 * A line UNDER a row, on the panel's rail — a conflict line, a validation
 * message, an "Upstream: …" note. It is NOT a row: it takes no row height,
 * reserves no track, and reaches the rail by being ordinary content, exactly the
 * way `Empty` does.
 */
export function SettingNote({ children }: { children: React.ReactNode }) {
  return (
    <Text as="div" variant="caption" tone="muted" className="pb-2xs">
      {children}
    </Text>
  );
}

/**
 * Prose under a label — a `Block`'s or a `Group`'s visible description.
 *
 * It sits on the PANEL's rail rather than under the label it explains, and that
 * is deliberate: reaching the text rail would mean applying an inset on top of
 * the region's, which is the double-inset the rail contract exists to make
 * impossible (and which `useRailGuard` reports). In a panel with no icon track —
 * which is every settings panel — the two rails coincide anyway.
 */
export function SettingDescription({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <Text as="div" variant="caption" tone="muted" className="pb-2xs">
      {children}
    </Text>
  );
}
