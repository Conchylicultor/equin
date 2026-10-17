import { Icon } from "@plugins/ui/plugins/icons/web";
import type { IconRef } from "@plugins/ui/plugins/icons/core";
import {
  Button,
  cn,
  type DensityControlled,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type { ComponentProps, ReactNode } from "react";
import { Kbd } from "@plugins/primitives/plugins/overlay/plugins/tooltip/web";
import { formatShortcutLabel } from "@plugins/primitives/plugins/shortcuts/web";
import {
  useActionForm,
  PanelActionRow,
} from "@plugins/primitives/plugins/action-presentation/web";

export interface IconButtonProps
  extends
    Omit<ComponentProps<typeof Button>, "children" | "size">,
    DensityControlled {
  icon: IconRef;
  /** Draw the icon in its active form (the theme's active fill): an on toggle, a pinned row. */
  active?: boolean;
  /**
   * Animate the glyph: `spin` while the action runs (a refresh), `pulse` while a
   * mode is live (listening). Full-form only — INERT in row form.
   */
  motion?: "spin" | "pulse";
  /**
   * The glyph's size inside the (density-sized) box. `control` (the default)
   * is the density's own icon size; `small` draws a 14px glyph in the same box
   * — a secondary action beside full-size ones, at the same height. Full-form
   * only — INERT in row form.
   */
  glyph?: "control" | "small";
  /** The action's name: the aria-label + tooltip at full size, the visible row text in row form. */
  label: string;
  /**
   * Overrides the label as the tooltip. Full-form only — INERT in row form
   * (the label is already visible text there), as is `tooltipSide`.
   */
  tooltip?: ReactNode;
  shortcut?: string;
}

/**
 * A ladder rung this widget can render itself as. Module scope, not an inline
 * literal, purely for the reader: it is the one thing `IconButton` says about
 * itself to a bar, and it says it once. `useActionForm` keys its declaration on
 * the ladder's VALUE, so an inline literal would behave identically.
 *
 * Deliberately NOT `"compact"`: an icon button is already an icon-only square,
 * so it has no narrower form of itself to offer — below full it either stays as
 * it is or becomes a labelled row.
 */
const ICON_BUTTON_LADDER = { shrinksTo: ["row"] } as const;

/**
 * `IconButton` IS the generic `{ icon, label, onClick }` action shape, so it is
 * the one widget for which "a labelled row" is a lossless smaller form of
 * itself — and therefore the one that declares the `"row"` rung. When a bar runs
 * out of room and relocates it behind a `⋯`, the same action renders as that
 * row. The full-form-only dials — `variant`, `className`, `tooltip`, `tooltipSide` —
 * are INERT in that form.
 */
export function IconButton({
  icon,
  active,
  motion,
  glyph = "control",
  label,
  tooltip,
  shortcut,
  variant = "ghost",
  ...props
}: IconButtonProps) {
  // Unconditional (hook order): declare the ladder and read the region's
  // answer, then one branch on it. With no bar above — every ordinary call site
  // — this is a constant `"full"` and the declaration is a no-op.
  const form = useActionForm(ICON_BUTTON_LADDER);
  if (form === "row") {
    return (
      <PanelActionRow
        icon={icon}
        active={active}
        label={label}
        onClick={props.onClick}
        onAuxClick={props.onAuxClick}
        onMouseDown={props.onMouseDown}
        disabled={props.disabled}
        shortcut={shortcut}
      />
    );
  }

  // An icon button NEVER sizes itself — `aspect="icon"` makes Button derive its
  // square box from the ambient control density, which the containing row/slot
  // owns (via `ControlSizeProvider` or a slot's `controlSize` config). This makes
  // a single button physically unable to desync from its neighbors.
  const content = shortcut ? (
    <>
      {tooltip ?? label}
      <Kbd>{formatShortcutLabel(shortcut)}</Kbd>
    </>
  ) : (
    (tooltip ?? label)
  );

  return (
    // eslint-disable-next-line icon-button/prefer-icon-button -- this IS IconButton: the one place a Button wraps a lone <Icon>
    <Button
      variant={variant}
      aspect="icon"
      aria-label={label}
      tooltip={content}
      {...props}
    >
        <Icon
          icon={icon}
          active={active}
          className={cn(
            motion === "spin" && "animate-spin",
            motion === "pulse" && "animate-pulse",
            glyph === "small" && "size-3.5",
          )}
        />
    </Button>
  );
}
