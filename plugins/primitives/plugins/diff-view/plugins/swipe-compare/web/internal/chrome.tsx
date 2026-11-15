import type { ReactElement } from "react";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { clipClasses } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { symbol } from "@plugins/ui/plugins/icons/core";

/**
 * What every comparison surface shares — fitted (`swipe-compare.tsx`) or
 * zoomable (`zoomed-compare.tsx`): the divider's key steps, the frame, the
 * corner tags.
 */

/** How the two sides are compared. */
export type SwipeCompareMode = "swipe" | "side" | "flip";

/**
 * What the primitive draws around the two sides.
 *
 * - `full` — a standalone comparison: a framed surface (rounded, ringed,
 *   clipped), a white divider with a round ‹› knob, and Before / After corner
 *   tags. What a pair of screenshots wants.
 * - `minimal` — for a host that draws its own frames and names (the prototype
 *   canvas): no frame, no knob, no tags, and a hairline divider in the
 *   foreground colour (the primary while dragged).
 */
export type SwipeCompareChrome = "full" | "minimal";

export const knobIcon = symbol("code");

/** One arrow key's step, and Shift's. */
const STEP = 0.02;
const BIG_STEP = 0.1;
/** Below / above this position the tag it would cover fades out. */
export const TAG_EDGE = 0.14;
/** The gap between the two sides side by side, in px (the `smd` step). */
export const SIDE_GAP_PX = 10;

/** A position clamped to the track. */
export function clampAt(at: number): number {
  return Math.min(1, Math.max(0, at));
}

/**
 * Where a key moves the divider from `at`, or null when the key is not one
 * the divider answers.
 */
export function keyedAt(
  key: string,
  shift: boolean,
  at: number,
): number | null {
  const step = shift ? BIG_STEP : STEP;
  switch (key) {
    case "ArrowLeft":
      return clampAt(at - step);
    case "ArrowRight":
      return clampAt(at + step);
    case "Home":
      return 0;
    case "End":
      return 1;
    default:
      return null;
  }
}

/** A dark scrim for a tag laid over an image. Deliberately not a theme token:
 *  it must read against the picture under it, which no palette knows. */
const TAG_CLASS =
  "pointer-events-none rounded-sm bg-black/60 px-xsm py-2xs text-white backdrop-blur-sm transition-opacity";

export const FOCUS_CLASS =
  "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

/**
 * A side's frame. `full` draws and clips one; `minimal` draws nothing and
 * clips nothing, so the host's own frames (their rounding, ring and shadow)
 * show whole.
 */
export function frameClass(chrome: SwipeCompareChrome): string | null {
  return chrome === "full"
    ? cn(
        clipClasses({ axis: "both", fill: false }),
        "rounded-lg bg-muted shadow-lg ring-1 ring-border",
      )
    : null;
}

export function Tag({
  children,
  to,
  hidden = false,
}: {
  children: string;
  to: "bottom-left" | "bottom-right";
  hidden?: boolean;
}): ReactElement {
  return (
    <Pin
      to={to}
      offset="sm"
      layer="raised"
      decorative
      className={cn(TAG_CLASS, hidden && "opacity-0")}
    >
      <Text variant="tag">{children}</Text>
    </Pin>
  );
}
