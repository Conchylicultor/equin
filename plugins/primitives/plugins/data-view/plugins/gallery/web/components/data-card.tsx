import { type CSSProperties, type ReactNode } from "react";
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
  coverHeldAttr,
} from "@plugins/primitives/plugins/data-view/web";
import {
  dataPart,
  type CoverContent,
} from "@plugins/primitives/plugins/data-view/core";
import { dataViewGroup } from "@plugins/ui/plugins/tokens/plugins/data-view/core";

/** The cover tokens' lengths, as `Pin` insets (the `style` overriding its
 *  anchor insets — `Pin offset` takes only ramp steps). */
const CHIP_INSET = `var(${dataViewGroup.vars.coverChipInset})`;
const PRIMARY_INSET_LEN = `var(${dataViewGroup.vars.coverPrimaryInset})`;
const CHIP_TOP_LEFT: CSSProperties = { top: CHIP_INSET, left: CHIP_INSET };
const CHIP_TOP_RIGHT: CSSProperties = { top: CHIP_INSET, right: CHIP_INSET };
const PRIMARY_INSET: CSSProperties = {
  bottom: PRIMARY_INSET_LEN,
  right: PRIMARY_INSET_LEN,
};

/**
 * The primary action's button takes the `coverPrimarySize` token — only when a
 * theme sets it (a style query on the unset value), so by default the action
 * keeps the size it draws itself at.
 */
const PRIMARY_SIZE =
  "[@container_not_style(--cover-primary-size:initial)]:[&_button]:size-cover-primary";

/**
 * …and its fill, ink and shadow (`coverPrimaryFill` / `Ink` / `Shadow`), each
 * only when a theme sets it — unset, the action's own paint stays.
 */
const PRIMARY_PAINT = [
  "[@container_not_style(--cover-primary-fill:initial)]:[&_button]:bg-cover-primary-fill",
  "[@container_not_style(--cover-primary-ink:initial)]:[&_button]:text-cover-primary-ink",
  "[@container_not_style(--cover-primary-shadow:initial)]:[&_button]:shadow-cover-primary",
].join(" ");

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
  /**
   * Draw the card as hovered whatever the pointer does — it is the hovered row
   * of a surface showing the same rows elsewhere (a map pin). The card's own
   * hover look, held: the cover lifted, a muted cover's veil lifted.
   */
  hovered?: boolean;
  /** The pointer entered (`true`) or left (`false`) the card. */
  onHoverChange?: (hovered: boolean) => void;
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
 * card owns placement only. Every distance is a `tokens/data-view` token: the
 * room between cover and text (`cardMetaPadTop`), the chips' and the primary's
 * insets (`coverChipInset` / `coverPrimaryInset`) and the primary's size.
 */
export function DataCard({
  rowKey,
  onActivate,
  selected,
  hovered,
  onHoverChange,
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
      gap="none"
      data-row-key={rowKey}
      {...dataPart("dv.card")}
      role={activates ? "button" : undefined}
      tabIndex={activates ? 0 : undefined}
      {...activationProps(onActivate)}
      {...{ [coverHeldAttr]: hovered === true ? "true" : undefined }}
      {...(onHoverChange === undefined
        ? {}
        : {
            onPointerEnter: () => onHoverChange(true),
            onPointerLeave: () => onHoverChange(false),
          })}
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
            className="bg-background/50 transition-opacity group-hover/cover:opacity-0 group-data-[cover-held=true]/cover:opacity-0"
          />
        ) : null}
        {badge ? (
          <Pin to="top-left" style={CHIP_TOP_LEFT}>
            {badge}
          </Pin>
        ) : null}
        {cluster ? (
          <Pin
            to="top-right"
            style={CHIP_TOP_RIGHT}
            {...dataPart("dv.cover-actions")}
          >
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
          <Pin
            to="bottom-right"
            style={PRIMARY_INSET}
            className={cn(PRIMARY_SIZE, PRIMARY_PAINT)}
            {...dataPart("dv.cover-primary")}
          >
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
      <div className="pt-card-meta px-card-meta">{children}</div>
    </Stack>
  );
}
