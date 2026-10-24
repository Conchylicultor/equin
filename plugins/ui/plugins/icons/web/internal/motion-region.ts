/**
 * Attribute props marking a MOTION REGION: spread on an element, and every
 * animated family glyph inside it plays its motion once when the control
 * holding it (a link, a button, an option, a tree item, a menu item) is
 * hovered — `icon-motion.css`, pure CSS, restarted on each hover entry.
 * Outside a region the same glyphs stay still: the toolbar, menus and popovers
 * (portalled out of the region's DOM) never move.
 *
 * ```tsx
 * <nav {...IconMotionRegion}>…</nav>
 * ```
 */
export const IconMotionRegion = { "data-icon-motion-region": "" } as const;
