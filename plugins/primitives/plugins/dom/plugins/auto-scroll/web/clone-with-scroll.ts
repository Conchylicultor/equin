/** How much of the source {@link cloneWithScroll} copies. */
export interface CloneWithScrollOptions {
  /**
   * Copy only what `source` can show: every descendant whose box lies wholly
   * outside the clip it is drawn through (`source`'s own box, narrowed on
   * each axis an ancestor's `overflow` clips) is copied as an empty box of
   * its size, its subtree left out. Reads `source`'s layout, so it must have
   * one (a `content-visibility: hidden` subtree keeps the one it had).
   *
   * For a picture of `source` — a still thumbnail — where styling the copy is
   * the cost: a scrolled app is mostly content out of view (a Sonata library
   * window holds ~4.3k elements, ~570 in its box).
   *
   * The empty boxes hold their place, but not to the sub-pixel (a collapsed
   * child margin, a rounding per row add up over a long list), so each
   * scroller's carried offset is then corrected against the first element
   * that starts in its view: what shows lands where the source showed it.
   * Kept whole, never emptied: an inline box (it has no size of its own), an
   * inline block (its baseline is its content's), a table part (its cells
   * size the columns). An empty box (a `display: contents` wrapper, a
   * zero-height anchor) is never judged outside, and an absolutely or fixed
   * placed one is judged against `source`'s box only — the scroller around it
   * may not be what clips it.
   */
  visibleOnly?: boolean;
}

/** Where an element of the copy sits in its scroller, in layout px (`visibleOnly`). */
interface Anchor {
  el: Element;
  dx: number;
  dy: number;
}

/** A scroller of the source's copy and the offset it must take. */
interface Place {
  el: Element;
  top: number;
  left: number;
  anchor?: Anchor;
}

/**
 * A deep copy of `source` that, once placed, shows what `source` showed — its
 * scroll offsets included. `cloneNode` copies the DOM but not where each
 * scroller stood (a transcript scrolled half-way would show its top), and an
 * offset can only be written on a connected element, so the copy comes with
 * `carryScroll`: call it right after inserting `clone`.
 *
 * Nothing in the copy loads anything: a copied frame or media element would
 * fetch its source again the moment it is placed (a whole video re-downloaded
 * to fade out, a revoked `blob:` URL failing in the console), so each one is
 * kept as an empty box of the same size and look ({@link inertCopy}).
 *
 * For a stand-in drawn in place of content React is about to remove (a column
 * fading out after its pane closed), or a picture of content still there
 * (`visibleOnly`). A compensation, not a navigation — no reader moved, so it
 * announces nothing.
 */
export function cloneWithScroll<T extends Element>(
  source: T,
  { visibleOnly = false }: CloneWithScrollOptions = {},
): { clone: T; carryScroll: () => void } {
  const places: Place[] = [];
  const clone = visibleOnly
    ? (copyVisible(source, places) as T)
    : copyAll(source, places);
  for (const el of clone.querySelectorAll(LOADING_ELEMENTS)) inertCopy(el);
  return {
    clone,
    carryScroll: () => {
      // Outer scrollers first (document order): an inner one's anchor is
      // measured against its own box, which the outer offset has placed.
      for (const { el, top, left, anchor } of places) {
        el.scrollTop = top;
        el.scrollLeft = left;
        if (!anchor) continue;
        const at = offsetIn(anchor.el, el);
        el.scrollTop += at.dy - anchor.dy;
        el.scrollLeft += at.dx - anchor.dx;
      }
    },
  };
}

/** The whole of `source`, every scrolled element's offset recorded. */
function copyAll<T extends Element>(source: T, places: Place[]): T {
  const clone = source.cloneNode(true) as T;
  const from = [source, ...source.querySelectorAll("*")];
  const to = [clone, ...clone.querySelectorAll("*")];
  from.forEach((el, i) => {
    const copy = to[i];
    if (copy && scrolled(el))
      places.push({ el: copy, top: el.scrollTop, left: el.scrollLeft });
  });
  return clone;
}

function scrolled(el: Element): boolean {
  return el.scrollTop !== 0 || el.scrollLeft !== 0;
}

/** A viewport rectangle a subtree is drawn through. */
interface Clip {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** A scrolled element of the source being walked, still looking for its anchor. */
interface OpenPlace {
  place: Place;
  from: Element;
  box: DOMRect;
}

/** `source` with only what can show (`visibleOnly`). */
function copyVisible(source: Element, places: Place[]): Element {
  const box = source.getBoundingClientRect();
  return copyKept(source, box, box, places, []);
}

/**
 * `el` with only the descendants that can show through `clip`. A descendant
 * wholly outside is kept as an empty stand-in of the size it had
 * ({@link standIn}), never dropped: one scrolled out ABOVE the view still
 * holds the place the visible content sits at.
 */
function copyKept(
  el: Element,
  clip: Clip,
  root: Clip,
  places: Place[],
  open: OpenPlace[],
): Element {
  const copy = el.cloneNode(false) as Element;
  const style = getComputedStyle(el);
  let mine: OpenPlace | undefined;
  if (scrolled(el)) {
    const place: Place = { el: copy, top: el.scrollTop, left: el.scrollLeft };
    places.push(place);
    // The carried offset is written instantly, never animated.
    if (copy instanceof HTMLElement) copy.style.scrollBehavior = "auto";
    mine = { place, from: el, box: el.getBoundingClientRect() };
  }
  const inner = narrow(clip, el, style);
  const below = mine ? [...open, mine] : open;
  for (const child of el.childNodes) {
    if (!(child instanceof Element)) {
      copy.appendChild(child.cloneNode(true));
      continue;
    }
    const childStyle = getComputedStyle(child);
    const placed =
      childStyle.position === "absolute" || childStyle.position === "fixed";
    const r = child.getBoundingClientRect();
    if (outside(r, placed ? root : inner)) {
      copy.appendChild(standIn(child, childStyle));
      continue;
    }
    // A drawing is kept whole: its parts are not boxes worth judging.
    const kept =
      child instanceof SVGElement
        ? child.cloneNode(true)
        : copyKept(child, inner, root, places, below);
    copy.appendChild(kept);
    if (kept instanceof Element) claimAnchor(below, child, kept, r);
  }
  return copy;
}

/**
 * Hands `copy` to every open scroller still without an anchor whose view
 * `from` starts in — the first such element in document order, after its
 * own content (so the deepest one, the most precise).
 */
function claimAnchor(
  open: OpenPlace[],
  from: Element,
  copy: Element,
  r: DOMRect,
): void {
  for (const o of open) {
    if (o.place.anchor) continue;
    if (r.top < o.box.top || r.top >= o.box.bottom) continue;
    if (r.left < o.box.left || r.left >= o.box.right) continue;
    const at = offsetIn(from, o.from);
    o.place.anchor = { el: copy, dx: at.dx, dy: at.dy };
  }
}

/** Where `el` sits inside `scroller`'s box, in the scroller's layout px (any transform undone). */
function offsetIn(el: Element, scroller: Element): { dx: number; dy: number } {
  const r = el.getBoundingClientRect();
  const s = scroller.getBoundingClientRect();
  const scale =
    scroller instanceof HTMLElement && scroller.offsetWidth > 0
      ? s.width / scroller.offsetWidth
      : 1;
  return { dx: (r.left - s.left) / scale, dy: (r.top - s.top) / scale };
}

/** `clip` narrowed to `el`'s box on each axis its `overflow` clips. */
function narrow(clip: Clip, el: Element, style: CSSStyleDeclaration): Clip {
  const x = style.overflowX !== "visible";
  const y = style.overflowY !== "visible";
  if (!x && !y) return clip;
  const r = el.getBoundingClientRect();
  return {
    left: x ? Math.max(clip.left, r.left) : clip.left,
    right: x ? Math.min(clip.right, r.right) : clip.right,
    top: y ? Math.max(clip.top, r.top) : clip.top,
    bottom: y ? Math.min(clip.bottom, r.bottom) : clip.bottom,
  };
}

/** Whether a box lies wholly outside `clip` (an empty box never does: what it holds may overflow it). */
function outside(r: DOMRect, clip: Clip): boolean {
  if (r.width === 0 || r.height === 0) return false;
  return (
    r.right <= clip.left ||
    r.left >= clip.right ||
    r.bottom <= clip.top ||
    r.top >= clip.bottom
  );
}

/**
 * An element without its content, holding the box it had: its own
 * attributes (classes, so margins, position and borders stay) with its
 * used size pinned. An SVG keeps its own size attributes. Kept whole: an
 * inline box or inline block (no size of its own / a baseline from its
 * content) and a table part (its cells size the columns).
 */
function standIn(el: Element, style: CSSStyleDeclaration): Node {
  if (!(el instanceof HTMLElement)) return el.cloneNode(false);
  const display = style.display;
  if (display.startsWith("inline") || display.startsWith("table"))
    return el.cloneNode(true);
  const box = el.cloneNode(false) as HTMLElement;
  // The used size, unrounded and untransformed, in the element's own
  // box-sizing (what a computed width reads back as).
  Object.assign(box.style, {
    width: style.width,
    height: style.height,
    flex: "none",
  });
  return box;
}

/** Elements that fetch a source of their own once connected. */
const LOADING_ELEMENTS = "iframe, frame, object, embed, video, audio";

/** The attributes that name what such an element loads. */
const SOURCE_ATTRIBUTES = ["src", "srcdoc", "data", "poster"] as const;

/**
 * Empties a copied loading element before it is connected: its source
 * attributes go, and so do its `<source>` / `<track>` children — the box
 * keeps its classes and inline style, so it holds the same place.
 */
function inertCopy(el: Element): void {
  for (const name of SOURCE_ATTRIBUTES) el.removeAttribute(name);
  for (const child of el.querySelectorAll("source, track")) child.remove();
}
