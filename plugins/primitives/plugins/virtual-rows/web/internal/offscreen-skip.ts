/**
 * The browser's own windowing, for a box whose SIZE does not depend on its
 * content: `content-visibility: auto` — while the box is far from the
 * viewport the browser skips styling, laying out and painting what is inside
 * it, so a restyle of an ancestor (a theme or custom-property change, a
 * surface switch) pays only for what is on screen. The DOM stays: find in
 * page, focus, keyboard navigation and the accessibility tree all still reach
 * it, and the browser renders it before it scrolls into view.
 *
 * Where `VirtualRows` windows a long list by not mounting what is off screen,
 * this is for what stays mounted — a section under the windowing threshold,
 * the cards of several such sections stacked in one scroll.
 *
 * **Only on a box sized from outside its content**: a fixed height (a
 * token-sized line), an `aspect-ratio` over a definite width (a cover). A
 * skipped box is sized as if empty (size containment), so on a box its content
 * sizes it would collapse to nothing while off screen and jump when it
 * renders. The width must come from its container (a block box, a grid cell).
 *
 * The box also contains its paint while rendered: its content is clipped at
 * its padding edge plus `overflow-clip-margin` (0.5rem here — room for a focus
 * ring, an xs edit pencil (1.5rem) in a `1lh` line, or a glyph's descender).
 * Put it on a box whose content stays about inside (a clipped cover, a
 * one-line text box), never around something that draws far outside (a
 * lifted, shadowed card).
 *
 * Only where the browser honours that margin (`@supports`): WebKit (Safari,
 * the installed app windows' WKWebView) has no `overflow-clip-margin`, so
 * there the paint containment would clip at the box edge — the box is simply
 * not skipped, exactly as before.
 */
export const offscreenSkipClass =
  "[overflow-clip-margin:0.5rem] supports-[overflow-clip-margin:0.5rem]:[content-visibility:auto]";
