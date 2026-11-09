/**
 * How a frame's geometry moves when the layout changes (a size, a zoom, a
 * frame added or closed, the window resized): its box glides to the new one
 * in .35s on the viewer mock's ease-out curve, its corners with it. Only the
 * box's own properties transition, so nothing moves while the canvas scrolls;
 * with reduced motion, it jumps. Worn by the canvas's frame boxes and by the
 * screen inside each, which change together.
 */
export const GEOMETRY_MOTION =
  "transition-[left,top,width,height,border-radius] duration-350 ease-[cubic-bezier(.2,.8,.2,1)] motion-reduce:transition-none";

/**
 * How the page inside a screen follows it: the box it lays out in (its
 * logical width and height) and its zoom (`transform: scale`) transition on
 * the same curve and duration as the screen, so a layout change — a frame
 * added beside it, a size, a zoom — resizes the page continuously with its
 * box, the way a window being resized does, instead of re-laying it out at
 * the new size in one frame while the box around it is still on its way.
 * Worn by the scaled page layers (the prototype's iframe and its clip, a
 * source frame's render). With reduced motion, it jumps.
 */
export const PAGE_MOTION =
  "transition-[width,height,transform] duration-350 ease-[cubic-bezier(.2,.8,.2,1)] motion-reduce:transition-none";
