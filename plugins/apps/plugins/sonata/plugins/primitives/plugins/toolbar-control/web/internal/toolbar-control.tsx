import type { ReactNode } from "react";
import {
  cn,
  WithTooltip,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  Stack,
  Inset,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { hoverExpandHost } from "./hover-expand";

export interface ToolbarControlProps {
  /** Leading category icon (already sized, e.g. `<MdSpeed className="size-3.5" />`). */
  icon: ReactNode;
  /** Tooltip shown over the whole control. */
  tooltip: ReactNode;
  /** Dim + disable interaction (e.g. no song loaded). */
  disabled?: boolean;
  /**
   * Make the pill a hover-expand host: a `HoverExpandPanel` among the segments
   * opens while the pill is hovered or focused, and stays open while `held`
   * (e.g. a jog wheel mid-drag or mid-coast). Omit for a pill with nothing
   * folded away.
   */
  hoverExpand?: { held: boolean };
  /** The control's segments — buttons, a ribbed wheel face, a readout, … */
  children: ReactNode;
}

/**
 * The shared chrome for Sonata's toolbar "dial" controls — the speed/spread jog
 * wheels and the transpose stepper. A borderless pill, as tall as the toolbar's
 * buttons, with a leading muted category icon followed by a row of segments; it
 * lifts on hover like the buttons beside it. This frame owns the pill, the
 * tooltip, the no-song disabled dimming, and — crucially — the leading icon's
 * horizontal clearance from the rounded end, so its glyph never crowds it (the
 * old cross-control overlap glitch). Segment
 * dividers stay on the segments themselves (a `border-l`/`border-x`), not here,
 * so a control can divide its interior however it likes.
 */
export function ToolbarControl({
  icon,
  tooltip,
  disabled,
  hoverExpand,
  children,
}: ToolbarControlProps) {
  const host = hoverExpand ? hoverExpandHost(hoverExpand.held) : null;
  return (
    <WithTooltip content={tooltip}>
      <Stack
        direction="row"
        align="center"
        gap="none"
        {...host}
        className={cn(
          "rounded-full pr-xs transition-colors hover:bg-accent",
          host?.className,
          disabled && "pointer-events-none opacity-40",
        )}
        // As tall as the toolbar's own buttons, whatever density it declares.
        style={{ height: "var(--control-height-lg)" }}
      >
        {/* Horizontal clearance so the icon glyph doesn't crowd the rounded
            corner; vertical centering comes from the row's `align="center"`. */}
        <Inset x="xs" className="text-muted-foreground">
          {icon}
        </Inset>
        {children}
      </Stack>
    </WithTooltip>
  );
}
