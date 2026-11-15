import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  SwipeCompare,
  type SwipeCompareChrome,
  type SwipeCompareMode,
  type SwipeCompareProps,
} from "./internal/swipe-compare";
export { useCompareZoom, type CompareZoom } from "./internal/zoomed-compare";
export { CompareZoomControls } from "./internal/zoom-controls";
export type { ZoomFit } from "./internal/zoom-model";

export default {
  description:
    "<SwipeCompare before after mode at? onAtChange?/>: two renderings of one thing compared — swiped one over the other (a pointer-captured divider: drag or click the track, ←/→ with Shift ×5, Home/End, double-click to recentre; role=separator), side by side, or flipped between (click or Space). Controlled or uncontrolled; fits its box at an optional aspect, or zooms in it (useCompareZoom + CompareZoomControls: fit width / fit height / 1:1 / − + / wheel or pinch around the pointer, drag to pan — the image viewer's geometry, both sides at one view); chrome full (frame, knob, Before/After tags) or minimal (a hairline, for a host that frames and names its sides itself).",
  contributions: [],
} satisfies PluginDefinition;
