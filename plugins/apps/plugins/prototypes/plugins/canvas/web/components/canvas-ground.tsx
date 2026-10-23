import type { ReactElement } from "react";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";

/**
 * The ground the frames sit on: a 28px grid of hairlines in the foreground ink
 * at 3.6%, under a vignette that darkens to the background at the edges — the
 * viewer mock's `.canvas`. It does not scroll: the frames move over it.
 */
export const CANVAS_GROUND =
  "bg-background bg-[image:radial-gradient(ellipse_90%_85%_at_50%_50%,transparent_55%,var(--background)_100%),linear-gradient(color-mix(in_oklab,var(--foreground)_3.6%,transparent)_1px,transparent_1px),linear-gradient(90deg,color-mix(in_oklab,var(--foreground)_3.6%,transparent)_1px,transparent_1px)] bg-[size:100%_100%,28px_28px,28px_28px] bg-[position:0_0,-1px_-1px,-1px_-1px]";

/**
 * The canvas ground as a decorative layer that fills its box — for a surface
 * that wants to sit on the viewer's ground without being the canvas (the
 * gallery passes it as its pane's `ground`, so a card lies on the same grid as
 * the frame it opens).
 */
export function CanvasGround(): ReactElement {
  return <div aria-hidden className={cn("h-full w-full", CANVAS_GROUND)} />;
}
