import { useId } from "react";
import { Layer } from "@plugins/primitives/plugins/css/plugins/layer/web";
import { ViewportOverlay } from "@plugins/primitives/plugins/css/plugins/viewport-overlay/web";
import { ANCHOR_PADDING, inflate, type HintRect } from "../internal/rect";

/** Corner radius of the cut-out, in px — a soft box around any control. */
const CUTOUT_RADIUS = 10;

/**
 * The spotlight's drawing: a dim scrim over its positioned parent with a
 * rounded cut-out around `rect` (in the parent's coordinates) and a primary
 * ring on the cut-out's edge. Click-through: the user keeps acting on the app,
 * the anchor included.
 */
export function SpotlightMask({ rect }: { rect: HintRect }) {
  const maskId = useId();
  const hole = inflate(rect, ANCHOR_PADDING);
  return (
    <Layer as="svg" decorative aria-hidden className="size-full">
      <defs>
        <mask id={maskId}>
          <rect width="100%" height="100%" fill="white" />
          <rect
            x={hole.x}
            y={hole.y}
            width={hole.width}
            height={hole.height}
            rx={CUTOUT_RADIUS}
            fill="black"
          />
        </mask>
      </defs>
      <rect
        width="100%"
        height="100%"
        mask={`url(#${maskId})`}
        className="fill-black/45"
      />
      <rect
        x={hole.x}
        y={hole.y}
        width={hole.width}
        height={hole.height}
        rx={CUTOUT_RADIUS}
        className="fill-none stroke-primary"
        strokeWidth={2}
      />
    </Layer>
  );
}

/** The spotlight over the whole viewport, for a tour step on `rect`. */
export function Spotlight({ rect }: { rect: HintRect }) {
  return (
    <ViewportOverlay className="pointer-events-none">
      <SpotlightMask rect={rect} />
    </ViewportOverlay>
  );
}
