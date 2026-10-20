/**
 * Stamp on an element whose CSS animation or transition grows the content of
 * a `useStickyScroll` surface — a row easing open, a block easing to its new
 * height. While any stamped element is mid-motion, a following surface writes
 * the bottom every frame, so the transcript glides with the motion instead of
 * catching up in threshold-sized steps once the content end leaves the
 * observer's margin.
 *
 * Motion-scoped by construction: the per-frame writes run only between a
 * stamped element's `animationstart` / `transitionrun` and its end (or its
 * leaving the DOM), never as a standing loop — so an infinite animation must
 * not carry the stamp.
 */
export const FOLLOW_MOTION_ATTR = "data-follow-motion";
