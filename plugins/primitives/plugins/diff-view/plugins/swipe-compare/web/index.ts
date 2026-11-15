import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  SwipeCompare,
  type SwipeCompareChrome,
  type SwipeCompareMode,
  type SwipeCompareProps,
} from "./internal/swipe-compare";

export default {
  description:
    "<SwipeCompare before after mode at? onAtChange?/>: two renderings of one thing compared — swiped one over the other (a pointer-captured divider: drag or click the track, ←/→ with Shift ×5, Home/End, double-click to recentre; role=separator), side by side, or flipped between (click or Space). Controlled or uncontrolled; fits its box at an optional aspect; chrome full (frame, knob, Before/After tags) or minimal (a hairline, for a host that frames and names its sides itself).",
  contributions: [],
} satisfies PluginDefinition;
