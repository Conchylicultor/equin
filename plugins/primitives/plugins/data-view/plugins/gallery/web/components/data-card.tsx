import { type ReactNode } from "react";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  RowActions,
  rowActionsAnchor,
} from "@plugins/primitives/plugins/row-actions/web";
import { activationProps } from "@plugins/primitives/plugins/link-gesture/web";
import {
  runActivation,
  type Activation,
} from "@plugins/primitives/plugins/link-gesture/core";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { Layer } from "@plugins/primitives/plugins/css/plugins/layer/web";
import {
  CoverFrame,
  coverHoverGroup,
} from "@plugins/primitives/plugins/data-view/web";
import type { CoverContent } from "@plugins/primitives/plugins/data-view/core";

/**
 * A card's item actions, already split by the zone rule (`useItemActionZones`
 * arms applied to the card's row). Each is drawn where the card puts that arm;
 * an absent one draws nothing.
 */
export interface DataCardActions {
  /** The cluster's actions resting for this row (pinned, done…): always shown,
   *  at the cover's top-right edge. */
  atRest?: ReactNode;
  /** The cluster's other actions: revealed on hover, to the LEFT of the
   *  resting ones (which keep the edge). */
  revealed?: ReactNode;
  /** The primary action while it is active (playing): shown at rest, at the
   *  cover's bottom-right. */
  primaryAtRest?: ReactNode;
  /** The primary action otherwise: revealed on hover, same place. */
  primaryRevealed?: ReactNode;
}

export interface DataCardProps {
  /**
   * The card's row key in a DataView, stamped as `data-row-key` — the marker
   * every DataView row carries, by which it measures the rows on screen.
   */
  rowKey?: string;
  /** Card click + Enter/Space (role=button, tabIndex=0). A plain action, or a
   *  link (middle- / ⌘-click open it in a browser tab). */
  onActivate?: Activation;
  /** Persistent selected highlight: a ring around the cover. */
  selected?: boolean;
  /** The row reads as inactive (`RowTone` `"muted"`): the picture is veiled at
   *  rest, clear again under the pointer. The title's tone is the meta's. */
  dimmed?: boolean;
  /** The picture. `null` = a blank tinted frame, the same size as every other
   *  card's (a covered surface's coverless row). */
  cover: CoverContent | null;
  /** A corner mark over the cover's top-left (the aggregate `×N`). */
  badge?: ReactNode;
  actions?: DataCardActions;
  /** The text under the cover — the gallery's `<CardMeta>`. */
  children: ReactNode;
}

/**
 * The gallery card: the COVER is the card. A `<CoverFrame size="card">` (one
 * fixed 16/10 shape) carrying the card's overlays, then the text under it —
 * no padded container around the two.
 *
 * - **Top-right**: one pin holding `[revealed][at rest]` — each arm its own
 *   float chip (`RowActions chrome="float"`). At rest only the resting
 *   actions show; hover adds the others to their left, so a resting icon never
 *   moves.
 * - **Bottom-right**: the primary action (the action draws its own round
 *   button for `placement: "primary"`) — on hover, or at rest while active.
 * - **Top-left**: the `badge`.
 *
 * Hovering anywhere on the card lifts the cover (`coverHoverGroup`) and reveals
 * the hover arms (`rowActionsAnchor`); every reveal is `RowActions`', so the
 * card owns placement only.
 */
export function DataCard({
  rowKey,
  onActivate,
  selected,
  dimmed,
  cover,
  badge,
  actions,
  children,
}: DataCardProps): ReactNode {
  // A card with no `onActivate` is not a button: no role, no tab stop, no key
  // handler. Announcing one as a button and giving it a focus stop is a promise
  // the card cannot keep.
  const activates = onActivate !== undefined;
  const cluster = actions?.atRest != null || actions?.revealed != null;
  const primary =
    actions?.primaryAtRest != null || actions?.primaryRevealed != null;

  return (
    <Stack
      gap="sm"
      data-row-key={rowKey}
      role={activates ? "button" : undefined}
      tabIndex={activates ? 0 : undefined}
      {...activationProps(onActivate)}
      onKeyDown={
        activates
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                runActivation(onActivate);
              }
            }
          : undefined
      }
      // `rowActionsAnchor` carries `relative` too; the overlays anchor to the
      // cover frame (itself positioned), not to the card.
      className={cn(
        rowActionsAnchor,
        coverHoverGroup,
        "focus-ring rounded-cover",
        activates && "cursor-pointer",
      )}
    >
      <CoverFrame
        size="card"
        content={cover}
        className={cn(selected && "ring-2 ring-primary")}
      >
        {dimmed ? (
          <Layer
            decorative
            className="bg-background/50 transition-opacity group-hover/cover:opacity-0"
          />
        ) : null}
        {badge ? (
          <Pin to="top-left" offset="sm">
            {badge}
          </Pin>
        ) : null}
        {cluster ? (
          <Pin to="top-right" offset="sm">
            <Stack direction="row" gap="2xs" align="center">
              {actions?.revealed != null ? (
                <RowActions pin={null} chrome="float">
                  {actions.revealed}
                </RowActions>
              ) : null}
              {actions?.atRest != null ? (
                <RowActions pin={null} alwaysVisible chrome="float">
                  {actions.atRest}
                </RowActions>
              ) : null}
            </Stack>
          </Pin>
        ) : null}
        {primary ? (
          <Pin to="bottom-right" offset="sm">
            {actions?.primaryAtRest != null ? (
              <RowActions pin={null} alwaysVisible>
                {actions.primaryAtRest}
              </RowActions>
            ) : null}
            {actions?.primaryRevealed != null ? (
              <RowActions pin={null}>{actions.primaryRevealed}</RowActions>
            ) : null}
          </Pin>
        ) : null}
      </CoverFrame>
      {children}
    </Stack>
  );
}
