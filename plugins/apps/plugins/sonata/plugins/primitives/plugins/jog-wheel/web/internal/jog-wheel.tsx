import type { ReactNode } from "react";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import type { InertialDragHandle } from "@plugins/apps/plugins/sonata/plugins/primitives/plugins/inertial-drag/web";
import {
  HoverExpandPanel,
  ToolbarControl,
} from "@plugins/apps/plugins/sonata/plugins/primitives/plugins/toolbar-control/web";

/** ARIA slider metadata for the ribbed face (all values are already scaled to
 *  the integer domain the consumer wants exposed to assistive tech). */
export interface JogWheelAria {
  label: string;
  valueMin: number;
  valueMax: number;
  valueNow: number;
  valueText: string;
}

export interface JogWheelProps {
  /** Leading icon (already sized, e.g. `<MdSpeed className="size-3.5" />`).
   *  Rendered muted with horizontal clearance from the rounded corner. */
  icon: ReactNode;
  /** Tooltip shown over the whole control. */
  tooltip: ReactNode;
  /** Drag handle from `useInertialDrag`: pointer handlers + phase for the cursor. */
  drag: InertialDragHandle;
  /** Ribbed-face travel in px; bind to the value so the ribs slide as it scrubs. */
  ribOffsetPx: number;
  /** Formatted value shown in the right-hand readout (e.g. `"100%"`, `"1.5×"`). */
  readout: string;
  /** ARIA slider metadata for the ribbed face. */
  aria: JogWheelAria;
  /**
   * Fold the ribbed face away at rest, leaving icon + readout: it opens out
   * while the control is hovered or focused, and stays open while the drag is
   * not idle — so it never snaps shut mid-flick or mid-coast.
   */
  collapsible?: boolean;
}

/**
 * A horizontal jog wheel: a bordered pill with a leading icon, a ribbed
 * "physical wheel" face you drag to scrub a scalar, and a right-hand readout.
 * The face's ribs slide with `ribOffsetPx` for a tactile wheel feel; the drag
 * physics (grab → flick → coast → settle) come from `useInertialDrag`, whose
 * handle the consumer passes in as `drag`.
 *
 * The value MODEL is the consumer's: `SpreadWheel` scrubs `log(spread)` (a fixed
 * pixel travel = a fixed zoom ratio), `TempoWheel` scrubs linear tempo. This
 * primitive owns only the wheel-specific chrome (the ribbed face + readout); the
 * bordered pill, tooltip, and leading icon come from `ToolbarControl`, shared
 * with the transpose stepper.
 *
 * `collapsible` folds the face away at rest through toolbar-control's
 * hover-expand rule (the same one the volume slider uses), held open while the
 * drag is not idle.
 */
export function JogWheel({
  icon,
  tooltip,
  drag,
  ribOffsetPx,
  readout,
  aria,
  collapsible = false,
}: JogWheelProps) {
  // The ribbed wheel face. The tick pattern + its sliding position are inline
  // styles (no Tailwind spacing/radius to lint); the value-bound
  // background-position makes the ribs travel as the wheel is dragged.
  const face = (
    <Clip
      {...drag.handlers}
      role="slider"
      aria-label={aria.label}
      aria-valuemin={aria.valueMin}
      aria-valuemax={aria.valueMax}
      aria-valuenow={aria.valueNow}
      aria-valuetext={aria.valueText}
      className={cn(
        "relative h-6 w-16 touch-none select-none",
        drag.phase === "idle" ? "cursor-ew-resize" : "cursor-grabbing",
      )}
      style={{
        backgroundImage:
          "repeating-linear-gradient(90deg, var(--border) 0 1px, transparent 1px 9px)",
        backgroundPositionX: `${ribOffsetPx}px`,
        // Fade the ribs out at both edges so the strip reads as a wheel.
        maskImage:
          "linear-gradient(90deg, transparent, #000 25%, #000 75%, transparent)",
        WebkitMaskImage:
          "linear-gradient(90deg, transparent, #000 25%, #000 75%, transparent)",
      }}
    >
      {/* Center index mark the ribs travel past. */}
      {/* eslint-disable-next-line layout/no-adhoc-layout -- decorative center rule: horizontally centered (left-1/2 + translate) yet vertically stretched with a constant inset; not a single Pin anchor */}
      <div className="pointer-events-none absolute inset-y-1 left-1/2 w-px -translate-x-1/2 bg-primary" />
    </Clip>
  );
  return (
    <ToolbarControl
      icon={icon}
      tooltip={tooltip}
      hoverExpand={collapsible ? { held: drag.phase !== "idle" } : undefined}
    >
      {collapsible ? <HoverExpandPanel>{face}</HoverExpandPanel> : face}
      <Text
        as="span"
        variant="caption"
        className="min-w-9 font-bold text-foreground tabular-nums"
      >
        {readout}
      </Text>
    </ToolbarControl>
  );
}
