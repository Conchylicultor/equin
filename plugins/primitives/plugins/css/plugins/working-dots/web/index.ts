import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { WorkingDots, type WorkingDotsProps } from "./internal/working-dots";
export { WorkingText, type WorkingTextProps } from "./internal/working-text";

export default {
  description:
    "Three-dot working indicator with organic motion: <WorkingDots> varies each pass (duration, amplitude, lag) through smooth noise, carries the dots on springs with a faint overshoot and stretch, holds between passes with a breath, and cycles through every style (gooey, wave, leap, orbit, glow). Sized from the ambient ControlSize; pauses off screen; still under reduced motion. <WorkingText> is the label beside it: a highlight sweeping across the words, each new label sliding in.",
  contributions: [],
} satisfies PluginDefinition;
