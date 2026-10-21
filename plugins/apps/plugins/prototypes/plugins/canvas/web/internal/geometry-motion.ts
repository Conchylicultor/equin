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
