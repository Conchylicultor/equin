import { type ReactNode } from "react";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Surface } from "@plugins/primitives/plugins/css/plugins/surface/web";
import {
  Inset,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import {
  RowActions,
  rowActionsAnchor,
} from "@plugins/primitives/plugins/row-actions/web";
import { activationProps } from "@plugins/primitives/plugins/link-gesture/web";
import {
  runActivation,
  type Activation,
} from "@plugins/primitives/plugins/link-gesture/core";
import { dataPart } from "@plugins/primitives/plugins/data-view/core";
import type { DataCardActions } from "./data-card";

export interface PanelCardProps {
  /** Stamped as `data-row-key`, as on every DataView row. */
  rowKey?: string;
  /** Card click + Enter/Space (role=button, tabIndex=0). */
  onActivate?: Activation;
  /** Persistent selected highlight: a ring around the panel. */
  selected?: boolean;
  /** Draw the card as hovered whatever the pointer does (another surface
   *  hovers the same row). */
  hovered?: boolean;
  onHoverChange?: (hovered: boolean) => void;
  /** The row reads as inactive (`RowTone` `"muted"`): the panel is veiled. */
  dimmed?: boolean;
  /** The leading field's cell (the mark), drawn before the text. */
  leading?: ReactNode;
  /** The card's head text — the gallery's `<CardMeta omitTokens>`. */
  head: ReactNode;
  /** The footer — the gallery's `<CardTokens>`; absent = no footer. */
  footer?: ReactNode;
  /** The cluster arms only: a panel has no primary slot. */
  actions?: Pick<DataCardActions, "atRest" | "revealed">;
}

/**
 * The gallery's `card: "panel"` shape (`GalleryViewOptions`): a raised panel
 * with no picture. Head: the leading cell (the mark) beside the card text (the
 * title line with its indicators at the far end, then the subtitle); footer:
 * the tokens line under a hairline. The item-action cluster pins to the
 * panel's top-right corner, revealed on hover over the head's trailing end —
 * the same arms and reveal as the cover card's.
 */
export function PanelCard({
  rowKey,
  onActivate,
  selected,
  hovered,
  onHoverChange,
  dimmed,
  leading,
  head,
  footer,
  actions,
}: PanelCardProps): ReactNode {
  const activates = onActivate !== undefined;
  const cluster = actions?.atRest != null || actions?.revealed != null;
  return (
    <Surface
      level="raised"
      data-row-key={rowKey}
      {...dataPart("dv.card")}
      role={activates ? "button" : undefined}
      tabIndex={activates ? 0 : undefined}
      {...activationProps(onActivate)}
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
      className={cn(
        rowActionsAnchor,
        "focus-ring transition-colors hover:border-primary/45",
        hovered && "border-primary/45",
        selected && "ring-2 ring-primary",
        dimmed && "opacity-60 hover:opacity-100",
        activates && "cursor-pointer",
      )}
    >
      <Inset pad="md">
        <Stack direction="row" align="center" gap="md">
          {leading != null ? (
            <span className={rigidClass()}>{leading}</span>
          ) : null}
          <Fill>{head}</Fill>
        </Stack>
      </Inset>
      {footer != null ? (
        <Inset x="md" y="sm" className="border-t border-border/60">
          {footer}
        </Inset>
      ) : null}
      {cluster ? (
        <Pin to="top-right" offset="sm" {...dataPart("dv.cover-actions")}>
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
    </Surface>
  );
}
