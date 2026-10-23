import { Placed } from "@plugins/primitives/plugins/css/plugins/coords/web";
import { ViewportOverlay } from "@plugins/primitives/plugins/css/plugins/viewport-overlay/web";
import { ANCHOR_PADDING, inflate, type HintRect } from "../internal/rect";

/**
 * A pulsing primary ring around `rect` (in its positioned parent's
 * coordinates), with no scrim — how a contextual tip, or a step's cue, marks
 * its target without dimming the app.
 */
export function HaloRing({ rect }: { rect: HintRect }) {
  const box = inflate(rect, ANCHOR_PADDING);
  return (
    <Placed
      decorative
      x={{ start: box.x, size: box.width }}
      y={{ start: box.y, size: box.height }}
      className="animate-pulse rounded-control ring-2 ring-primary"
    />
  );
}

/** The halo over the whole viewport. */
export function Halo({ rect }: { rect: HintRect }) {
  return (
    <ViewportOverlay className="pointer-events-none">
      <HaloRing rect={rect} />
    </ViewportOverlay>
  );
}
