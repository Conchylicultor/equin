/**
 * The DOM half of the rubber-band: moving one scroll surface's content by an
 * offset the physics hands it, without breaking what a real scroll keeps right.
 *
 * The CONTENT moves (the surface's element children), never the surface box:
 * moving the box would drag its clip boundary over adjacent chrome (a toolbar,
 * a footer) and, since `transform` opens a stacking context, paint the content
 * above that chrome. Moving the content keeps the bounce inside the surface's
 * own `overflow` clip — the native model.
 *
 * A moved box only LOOKS like scrolling, so two things a real scroll gets right
 * are this file's job to keep right:
 *   - PINNED ELEMENTS STAY PINNED. A sticky element stuck to the surface's edge
 *     (a pane header, a table's column header, a menu's search bar) is chrome,
 *     not content: it is held where it is while the content moves under it —
 *     see `pinnedElements`.
 *   - THE SCROLL POSITION NEVER MOVES. A moved box counts for scrollable
 *     overflow where it is DRAWN, so pushing the content toward the start
 *     shortens the scroll range; at the end edge the browser then clamps the
 *     offset back by the same amount — see `anchorExtent`.
 *
 * Everything is measured once, in `lockSurface`, while nothing is moved yet.
 */

export type Axis = "x" | "y";

/** A surface locked for one bounce: draw offsets on it, then release it. */
export interface BounceSurface {
  readonly el: HTMLElement;
  readonly axis: Axis;
  /** Draw the content displaced by `offset` px on the axis. */
  draw(offset: number): void;
  /** Put back every inline style and remove the extent anchor. */
  release(): void;
}

const SCROLLABLE_OVERFLOW = new Set(["auto", "scroll", "overlay"]);
/** Overflow values that make an element the scroll container a sticky pins to. */
const SCROLL_CONTAINER_OVERFLOW = new Set([
  "auto",
  "scroll",
  "overlay",
  "hidden",
]);
/**
 * Where to look for pinned elements. `position: sticky` has one spelling in this
 * app — Tailwind's `sticky` utility, emitted by the `Sticky` primitive and the
 * two ui-kit menu headers that sit below it; inline `position: sticky` is banned
 * by `no-adhoc-layout`. Each match is still confirmed against its computed style.
 */
const STICKY_SELECTOR = ".sticky";
/** How far (px) a sticky element may sit from its pinned position and still count as stuck. */
const STUCK_EPS = 1;

/** Whether `node`'s computed overflow on `axis` lets the user scroll it. */
export function scrollsOn(node: Element, axis: Axis): boolean {
  const style = getComputedStyle(node);
  return SCROLLABLE_OVERFLOW.has(
    axis === "y" ? style.overflowY : style.overflowX,
  );
}

/** How far `surface` can scroll on `axis` (0 when its content fits). */
export function scrollRange(surface: HTMLElement, axis: Axis): number {
  return axis === "y"
    ? surface.scrollHeight - surface.clientHeight
    : surface.scrollWidth - surface.clientWidth;
}

/**
 * Fix what a bounce on `surface` moves, holds and anchors, for a first push of
 * sign `delta`. Returns null when the surface cannot bounce without breaking
 * something, in which case nothing was changed.
 */
export function lockSurface(
  surface: HTMLElement,
  axis: Axis,
  delta: number,
): BounceSurface | null {
  // A surface with no element children (only text/pseudo content) has nothing
  // to move safely; moving the box itself is what this file never does.
  const pinned = pinnedElements(surface, axis);
  const candidates = contentLayers(surface);
  const layerNodes = candidates.filter((c) => !pinned.includes(c));
  if (layerNodes.length === 0) return null;

  const layers = layerNodes.map((node) => toLayer(node, axis));

  // A push toward the start (scrolling down/right at the end) shortens a
  // scrollable surface's range unless something holds its end in place.
  let anchor: Anchor | null = null;
  if (delta > 0 && scrollRange(surface, axis) > 0) {
    anchor = anchorExtent(surface, axis, layers);
    if (anchor === null) {
      for (const l of layers) restoreLayer(l);
      return null;
    }
  }

  const held: Held[] = pinned
    .filter((p) => !candidates.includes(p))
    .map((node) => ({ node, at: edgeOf(node, axis) }));

  return {
    el: surface,
    axis,
    draw(offset) {
      for (const l of layers) moveLayer(l, axis, offset);
      anchor?.follow(offset);
      if (held.length === 0) return;
      // A held element is put back where it was MEASURED, not shifted by
      // `-offset`: under a relative inset a sticky re-resolves against its moved
      // ancestor on its own, and would be pushed off the edge by an assumed
      // correction. The individual `translate` property, so it keeps whatever
      // `transform` it has of its own. One layout: clear, read all, write all.
      for (const h of held) h.node.style.translate = "";
      const shifts = held.map((h) => h.at - edgeOf(h.node, axis));
      held.forEach((h, i) => {
        const d = shifts[i] ?? 0;
        h.node.style.translate = axis === "y" ? `0 ${d}px` : `${d}px 0`;
      });
    },
    release() {
      for (const l of layers) restoreLayer(l);
      for (const h of held) h.node.style.translate = "";
      anchor?.el.remove();
    },
  };
}

/**
 * The viewport's content layers — the boxes laid out directly in it. Moving
 * these (instead of the viewport box) keeps the bounce inside the viewport's
 * `overflow` clip, so it never escapes over adjacent chrome. Text/pseudo
 * children are skipped (only an element can be moved), and a `display:
 * contents` wrapper (a theme boundary around a pane header) is looked through:
 * it draws no box, so moving it moves nothing, and its children are the layers.
 */
function contentLayers(parent: HTMLElement): HTMLElement[] {
  return Array.from(parent.children).flatMap((c) =>
    !(c instanceof HTMLElement)
      ? []
      : getComputedStyle(c).display === "contents"
        ? contentLayers(c)
        : [c],
  );
}

/** A content layer being moved, and how — with the inline styles it had, to put back. */
interface Layer {
  node: HTMLElement;
  /**
   * `inset`: a relative offset (`top` / `left`). It moves the layer exactly as
   * a transform would, but opens no containing block for `position: fixed`
   * descendants — a transform makes a page's fixed widget (a floating button, a
   * side rail) resolve against the moved layer instead of the viewport, so it
   * jumps to the layer's own top for the length of the bounce — and no stacking
   * context. Only for a layer in normal flow (static, or relative with no inset
   * on the axis), whose `top` / `left` is ours to set. `transform` is the
   * fallback for any other layer.
   */
  how: "inset" | "transform";
  prev: { position: string; top: string; left: string; transform: string };
}

/** A pinned element inside a moved layer, with its edge's resting position. */
interface Held {
  node: HTMLElement;
  at: number;
}

function toLayer(node: HTMLElement, axis: Axis): Layer {
  const style = getComputedStyle(node);
  const inset = axis === "y" ? style.top : style.left;
  const how =
    style.position === "static" ||
    (style.position === "relative" && inset === "auto")
      ? "inset"
      : "transform";
  const { position, top, left, transform } = node.style;
  if (how === "inset") node.style.position = "relative";
  else node.style.willChange = "transform";
  return { node, how, prev: { position, top, left, transform } };
}

function moveLayer(layer: Layer, axis: Axis, offset: number): void {
  const { node, how } = layer;
  if (how === "inset") {
    node.style[axis === "y" ? "top" : "left"] = `${offset}px`;
  } else {
    node.style.transform =
      axis === "y" ? `translateY(${offset}px)` : `translateX(${offset}px)`;
  }
}

function restoreLayer({ node, how, prev }: Layer): void {
  node.style.position = prev.position;
  node.style.top = prev.top;
  node.style.left = prev.left;
  node.style.transform = prev.transform;
  if (how === "transform") node.style.willChange = "";
}

function edgeOf(node: HTMLElement, axis: Axis): number {
  const box = node.getBoundingClientRect();
  return axis === "y" ? box.top : box.left;
}

/** The edges a sticky element on this surface is pinned against, in client px. */
interface StickyView {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * The rectangle a sticky descendant of `surface` pins against: the scrollport,
 * deflated by the surface's own padding — Chromium resolves a sticky inset
 * against the scroller's content box, not its scrollport (measured; see the
 * `scroll-fade` utility in ui-kit's app.css).
 */
function stickyView(surface: HTMLElement): StickyView {
  if (surface === document.scrollingElement) {
    return {
      top: 0,
      left: 0,
      right: window.innerWidth,
      bottom: window.innerHeight,
    };
  }
  const box = surface.getBoundingClientRect();
  const style = getComputedStyle(surface);
  const top = box.top + surface.clientTop;
  const left = box.left + surface.clientLeft;
  return {
    top: top + parseFloat(style.paddingTop),
    left: left + parseFloat(style.paddingLeft),
    bottom: top + surface.clientHeight - parseFloat(style.paddingBottom),
    right: left + surface.clientWidth - parseFloat(style.paddingRight),
  };
}

/**
 * The sticky elements currently stuck to `surface`'s edges on `axis` — the ones
 * a bounce must hold still.
 *
 * Only elements pinned to THIS surface: a sticky inside a nested scroller pins
 * to that scroller, which moves with the content as a whole. And only elements
 * sitting exactly on their pinned position: a sticky still in flow further down
 * (a group header two groups below) is content, and moves with its rows. An
 * element resting on its in-flow position that happens to coincide with the edge
 * (a page's header at the top of the scroll) counts as pinned, so a bounce in
 * either direction slides the content under it — exactly what a pane whose
 * header sits outside its scroll does. A pinned element inside another is held
 * by its ancestor and not listed twice.
 */
function pinnedElements(surface: HTMLElement, axis: Axis): HTMLElement[] {
  const view = stickyView(surface);
  const pinned: HTMLElement[] = [];
  for (const node of surface.querySelectorAll<HTMLElement>(STICKY_SELECTOR)) {
    const style = getComputedStyle(node);
    if (style.position !== "sticky") continue;
    if (!pinsTo(node, surface)) continue;
    if (!isStuck(node, style, view, axis)) continue;
    // Document order: an enclosing pinned element was already listed.
    if (pinned.some((p) => p.contains(node))) continue;
    pinned.push(node);
  }
  return pinned;
}

/** Whether `surface` is the scroll container `node`'s sticky offset resolves against. */
function pinsTo(node: HTMLElement, surface: HTMLElement): boolean {
  for (let a = node.parentElement; a && a !== surface; a = a.parentElement) {
    const style = getComputedStyle(a);
    if (
      SCROLL_CONTAINER_OVERFLOW.has(style.overflowX) ||
      SCROLL_CONTAINER_OVERFLOW.has(style.overflowY)
    ) {
      return false;
    }
  }
  return true;
}

function isStuck(
  node: HTMLElement,
  style: CSSStyleDeclaration,
  view: StickyView,
  axis: Axis,
): boolean {
  const box = node.getBoundingClientRect();
  const at = (value: number, pinnedAt: number): boolean =>
    Math.abs(value - pinnedAt) < STUCK_EPS;
  if (axis === "y") {
    return (
      (style.top !== "auto" && at(box.top, view.top + parseFloat(style.top))) ||
      (style.bottom !== "auto" &&
        at(box.bottom, view.bottom - parseFloat(style.bottom)))
    );
  }
  return (
    (style.left !== "auto" &&
      at(box.left, view.left + parseFloat(style.left))) ||
    (style.right !== "auto" &&
      at(box.right, view.right - parseFloat(style.right)))
  );
}

/** The element holding a surface's scroll extent, and how it stays put. */
interface Anchor {
  el: HTMLElement;
  /** Cancel its host layer's `offset`, so the end it marks never moves. */
  follow(offset: number): void;
}

/** Elements that draw no children of theirs, so they cannot host the anchor. */
const CHILDLESS = new Set([
  "IMG",
  "INPUT",
  "TEXTAREA",
  "SELECT",
  "IFRAME",
  "VIDEO",
  "AUDIO",
  "CANVAS",
  "OBJECT",
  "EMBED",
  "BR",
  "HR",
  "svg",
]);

/** Whether a 1px box absolutely positioned in `node` counts for the surface's overflow. */
function canHostAnchor(node: HTMLElement): boolean {
  if (CHILDLESS.has(node.tagName)) return false;
  const style = getComputedStyle(node);
  // A clipping layer would clip the anchor out of the surface's overflow.
  return (
    style.overflowX === "visible" &&
    style.overflowY === "visible" &&
    !/paint|strict|content/.test(style.contain)
  );
}

/**
 * Hold `surface`'s scroll extent on `axis` while its content is moved toward
 * the start, or return null when that cannot be done.
 *
 * Scrollable overflow counts a moved box where it is drawn, so content pushed
 * up by N px ends N px sooner: the range shrinks by N, and at the end edge —
 * the only place such a push happens — the browser clamps the scroll offset
 * back by N. The bounce then cancels itself out, and as it decays the range
 * grows back under an offset that stays put, leaving the page N px short of its
 * end. An invisible 1px box whose far edge sits exactly on the current end
 * keeps the end where it was.
 *
 * OUT OF FLOW, so placing it cannot disturb the layout it measures: an
 * absolutely positioned box moves no sibling in any formatting context, and
 * can only grow scrollable overflow — never shrink it, so the browser never
 * clamps the scroll offset while it is placed. An in-flow box appended after
 * the last child (what this did until 2026-11) is laid out by the surface: in
 * a centred flex row (a markdown table's bleed scroller) it re-centred the
 * content and the range shrank under it, so every push at a table's end
 * yanked it ~100 px back — the table shook as it was scrolled right. Reversed,
 * wrapped, `space-*` or grid layouts each had their own way to move it.
 *
 * It lives in a moved layer (positioned by `toLayer`: its containing block, so
 * it is counted in the surface's overflow) and cancels the layer's offset each
 * frame. Whether it holds is measured, not assumed: unless it reaches the
 * extent exactly and adds none of its own on either axis, it is removed and
 * the bounce is skipped — a missing bounce is cosmetic, a scrolled page is not.
 */
function anchorExtent(
  surface: HTMLElement,
  axis: Axis,
  layers: Layer[],
): Anchor | null {
  const height = surface.scrollHeight;
  const width = surface.scrollWidth;
  const extent = axis === "y" ? height : width;
  const main = axis === "y" ? "top" : "left";
  const style = getComputedStyle(surface);

  // Where `el`'s far edge lands, in the surface's scroll coordinates (the end
  // padding is part of the extent).
  const reach = (el: HTMLElement): number => {
    const box = el.getBoundingClientRect();
    const origin = surface.getBoundingClientRect();
    return axis === "y"
      ? box.bottom -
          origin.top -
          surface.clientTop +
          surface.scrollTop +
          parseFloat(style.paddingBottom)
      : box.right -
          origin.left -
          surface.clientLeft +
          surface.scrollLeft +
          parseFloat(style.paddingRight);
  };

  for (const layer of layers) {
    if (!canHostAnchor(layer.node)) continue;
    const end = document.createElement("div");
    end.setAttribute("aria-hidden", "true");
    end.style.cssText =
      "position:absolute;top:0;left:0;width:1px;height:1px;margin:0;padding:0;border:0;pointer-events:none;visibility:hidden";
    layer.node.appendChild(end);
    const base = extent - reach(end);
    end.style[main] = `${base}px`;
    const holds =
      Math.abs(reach(end) - extent) <= 1 &&
      Math.abs(surface.scrollHeight - height) <= 1 &&
      Math.abs(surface.scrollWidth - width) <= 1;
    if (holds) {
      return {
        el: end,
        follow(offset) {
          end.style[main] = `${base - offset}px`;
        },
      };
    }
    end.remove();
  }
  return null;
}
