/**
 * Hit-testing for the inspector overlay — "what is under this pixel?".
 *
 * `document.elementFromPoint` answers a *different* question: "what would
 * receive a click here?". It honours `pointer-events`, which encodes the app's
 * **interactivity policy** — but picking is inspection, not interaction. Every
 * element the app has made non-interactive is invisible to it:
 *
 * - a disabled control (`disabled:pointer-events-none` on the button variant),
 * - a button's icon glyph (`[&_svg]:pointer-events-none`),
 * - click-through layers (`Overlay clickThrough`, decorative `Pin`).
 *
 * A pick on any of those silently resolved to the nearest *interactive
 * ancestor* and reported plausible-but-wrong metadata for a container the user
 * never pointed at — the failure mode that made the picker's own button
 * (disabled while picking is active) report the action bar's wrapper `div`.
 *
 * So the browser's hit test only **seeds** the search: from the element it
 * returns we descend to the deepest visible descendant whose box actually
 * contains the point, ignoring `pointer-events` entirely.
 */

/** A candidate, carried with its depth so the deepest one wins. */
interface Hit {
  el: Element;
  depth: number;
}

/**
 * True when any of the element's boxes contains the point. `getClientRects()`
 * (not `getBoundingClientRect()`) because an inline element wrapped across
 * lines has one box per line, and its bounding box covers the gaps between
 * them — which would swallow points that visually belong to a sibling.
 */
function containsPoint(el: Element, x: number, y: number): boolean {
  const rects = el.getClientRects();
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i]!;
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true;
  }
  return false;
}

/**
 * Decoration: an `aria-hidden` element with no content of its own — a hit-area
 * layer (`Row`'s full-bleed `absolute inset-0` span that keeps a split row's
 * padding clickable), a backdrop, a rule. It covers what the user points at
 * without being anything they could mean, so it is never selected: a pick on
 * a row's padding resolves to the row, not to the empty span spread over it.
 */
function isDecoration(el: Element): boolean {
  return (
    el.getAttribute("aria-hidden") === "true" &&
    el.childElementCount === 0 &&
    (el.textContent ?? "").trim() === ""
  );
}

/**
 * Depth-first search for the deepest selectable element containing the point.
 *
 * Pruning: a subtree whose root's box excludes the point is skipped. This
 * misses descendants that visually escape their parent's box (absolute
 * positioning under `overflow: visible`) — but those are hit-testable in their
 * own right, so `elementFromPoint` seeds the search at them directly.
 */
function deepestAt(
  el: Element,
  x: number,
  y: number,
  depth: number,
): Hit | null {
  // Never report the inspector's own chrome. The seed check can't cover this:
  // the overlay portals to `document.body`, so it is a *descendant* of the seed
  // whenever the pointer is over a body-level element.
  if (el.hasAttribute("data-element-picker")) return null;

  // An `<svg>` glyph is the leaf presentation of its host control; its
  // internals (`path`, `g`) are never a meaningful pick target, so the whole
  // subtree stands in for whatever hosts it.
  if (el instanceof SVGElement) return null;

  if (isDecoration(el)) return null;

  const style = getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return null;

  // Elements that generate no box of their own — `display: contents` (the slot
  // middleware's marker spans) and empty inlines — are traversed but never
  // selected: there is no box to have pointed at, and their children carry the
  // real geometry.
  const boxless =
    style.display === "contents" || el.getClientRects().length === 0;
  if (!boxless && !containsPoint(el, x, y)) return null;

  let best: Hit | null = boxless ? null : { el, depth };
  for (const child of el.children) {
    const hit = deepestAt(child, x, y, depth + 1);
    // `>=` so that among equally deep candidates the later sibling wins — it is
    // the one painted on top.
    if (hit && (!best || hit.depth >= best.depth)) best = hit;
  }
  return best;
}

/**
 * The element the user is pointing at, or `null` over the inspector's own
 * chrome (hover shows no highlight there, and a click is ignored).
 */
export function resolveTarget(x: number, y: number): Element | null {
  const seed = document.elementFromPoint(x, y);
  if (!seed) return null;
  if (seed.closest("[data-element-picker]")) return null;
  // A decoration the browser hit (a hit-area layer) stands for the nearest
  // ancestor whose own box holds the point — the layer may escape its parent's
  // box (a split row's hit-area spans the row, its parent is the inner button).
  let start = seed;
  while (
    (isDecoration(start) || !containsPoint(start, x, y)) &&
    start.parentElement
  )
    start = start.parentElement;
  // The start is itself a valid answer when nothing below it qualifies (it is a
  // leaf, or its only descendants are svg internals).
  return deepestAt(start, x, y, 0)?.el ?? start;
}
