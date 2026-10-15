/**
 * Framework-free core for the overscroll hint.
 *
 * Gives the app a native-feeling elastic **rubber-band** when a wheel /
 * trackpad / touch gesture is fully **wasted** — nothing actually scrolls
 * because the surface isn't scrollable or is already pinned at the edge in that
 * direction. Like iOS/macOS overscroll, the content follows the gesture *live*.
 *
 * We translate the viewport's CONTENT (its element children), never the viewport
 * box itself. Moving the box would drag its clip boundary over adjacent chrome
 * (a toolbar/footer) and, because `transform` opens a stacking context, paint
 * the overscrolled content *above* that chrome. Moving the content instead keeps
 * the bounce inside the viewport's own `overflow` clip — the native model: the
 * viewport stays put and clips, only the content inside it moves.
 *
 * The motion is a small continuous physics loop rather than a one-shot clip:
 *   - every wasted scroll event PUSHES the surface out, with resistance that
 *     grows as it nears the limit (so it asymptotes instead of running away);
 *   - every animation frame a spring-like DECAY pulls it back toward rest.
 * As trackpad momentum decays, the incoming pushes shrink, the decay wins, and
 * the surface recedes smoothly — it never stays pinned waiting for the momentum
 * tail to end. A fresh flick re-pushes it naturally, so repeated dead-end
 * scrolls always produce feedback. While a finger is down the decay pauses so
 * the surface tracks the touch 1:1, then springs back on release.
 *
 * Detection is cheap: we record each gesture, then on the next animation frame
 * check whether ANY real `scroll` event fired in the meantime. If none did AND
 * nothing the gesture could scroll has room left in its direction, the browser
 * genuinely scrolled nothing → wasted. (The first test alone is racy: a fast
 * flick's scroll event can land a frame late.) Expensive reads
 * (getComputedStyle, scroll geometry) only happen on the rare no-scroll-event
 * path, never on the hot wheel path.
 *
 * A transform only LOOKS like scrolling, so two things a real scroll gets right
 * are this file's job to keep right:
 *   - PINNED ELEMENTS STAY PINNED. A sticky element stuck to the viewport's edge
 *     (a pane header, a table's column header, a menu's search bar) is chrome, not
 *     content: it is held where it is while the content moves under it. Moving it
 *     with its content layer detached it from the edge and showed the page
 *     through the gap — see `pinnedElements`.
 *   - THE SCROLL POSITION NEVER MOVES. A translated box counts for scrollable
 *     overflow where it is DRAWN, so pushing the content toward the start
 *     shortened the scroll range by the push; at the end edge the browser then
 *     clamped the offset back by the same amount — the content never visibly
 *     moved, and the page was left short of its end. See `anchorExtent`.
 */

type Axis = "x" | "y";

interface PendingGesture {
  /** Native wheel event kept so we can read `defaultPrevented` after propagation. */
  event: Event | null;
  deltaX: number;
  deltaY: number;
  target: EventTarget | null;
  scrolledSince: boolean;
}

/** Minimum dominant-axis delta (px) for a gesture to count. */
const MIN_DELTA = 2;
/** The furthest the surface can rubber-band, in px (the resistance asymptote). */
const MAX_PULL = 48;
/**
 * Fraction of a wasted scroll delta that becomes outward displacement at rest.
 * Resistance scales this down toward 0 as the offset nears MAX_PULL, so a hard
 * flick reaches the limit in a few events and pushing further barely moves it.
 */
const PUSH_FACTOR = 0.32;
/**
 * Spring-back time constant (ms). Each frame the offset is multiplied by
 * exp(-dt / DECAY_TAU_MS); ~3·τ (~270ms) returns it essentially to rest. Small
 * enough to feel snappy, large enough to read as a spring rather than a cut.
 */
const DECAY_TAU_MS = 90;
/** Below this |offset| (px) we snap to 0 and stop the loop. */
const STOP_EPS = 0.4;
/** Clamp for a single frame's dt so a backgrounded tab can't teleport the decay. */
const MAX_FRAME_MS = 64;
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

/**
 * Install the global wasted-scroll detector. Returns a cleanup function that
 * removes every listener, cancels pending frames, and resets any surface left
 * mid-rubber-band.
 */
export function installOverscrollHint(): () => void {
  let pending: PendingGesture | null = null;
  let rafId: number | null = null;

  // Physics state for the surface currently being rubber-banded. `el` is the
  // scroll viewport we locked onto (kept for identity/axis tracking); `targets`
  // are the viewport's CONTENT layers (its element children) we actually
  // translate. Moving the content — not the viewport box — means the viewport's
  // own `overflow` clips the bounce, so the rubber-band can never slide its clip
  // boundary over adjacent chrome (a toolbar/footer) or paint above it via a
  // transform-induced stacking context. This is the native model: the viewport
  // stays put and clips; only the content inside it moves.
  //
  // `held` are pinned elements INSIDE a content layer, shifted back so they
  // stay on the edge (a pinned element that is itself a content layer is simply
  // left out of `targets`). `anchor` is the zero-size element holding the
  // scroll extent while the content is pushed toward the start. All three are
  // fixed when the bounce locks on and released together.
  let el: HTMLElement | null = null;
  let targets: Layer[] = [];
  let held: Held[] = [];
  let anchor: HTMLElement | null = null;
  let axis: Axis = "y";
  let offset = 0; // current signed displacement in px
  let touching = false; // finger down → hold (no decay) so it tracks 1:1
  let loopId: number | null = null;
  let lastTs: number | null = null;

  let touchStartX = 0;
  let touchStartY = 0;

  function reducedMotion(): boolean {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function recordGesture(
    event: Event | null,
    deltaX: number,
    deltaY: number,
    target: EventTarget | null,
  ): void {
    if (Math.abs(deltaY) < MIN_DELTA && Math.abs(deltaX) < MIN_DELTA) return;
    pending = { event, deltaX, deltaY, target, scrolledSince: false };
    if (rafId === null) {
      rafId = requestAnimationFrame(runDetection);
    }
  }

  function runDetection(): void {
    rafId = null;
    const gesture = pending;
    pending = null;
    if (!gesture) return;

    // A real scroll happened somewhere → not wasted.
    if (gesture.scrolledSince) return;

    // The gesture was intentionally consumed (e.g. graph zoom / canvas pan).
    if (gesture.event?.defaultPrevented) return;

    const gestureAxis: Axis =
      Math.abs(gesture.deltaX) > Math.abs(gesture.deltaY) ? "x" : "y";
    const delta = gestureAxis === "x" ? gesture.deltaX : gesture.deltaY;
    if (delta === 0) return;
    if (reducedMotion()) return;

    // No scroll event is not proof by itself: under a fast flick the event for
    // this gesture's scroll can land a frame after the check, and the page then
    // jumped mid-scroll. A gesture is wasted only if nothing it could scroll has
    // room left in its direction.
    const start = gesture.target instanceof Element ? gesture.target : null;
    if (hasRoomToScroll(start, gestureAxis, delta)) return;

    const surface = pickScrollSurface(
      gesture.target instanceof Element ? gesture.target : null,
      gestureAxis,
    );
    if (!(surface instanceof HTMLElement)) return;

    // Switching surface or axis mid-flight: reset the old one cleanly.
    if (el && (el !== surface || axis !== gestureAxis)) {
      resetSurface();
    }

    if (el === null && !lockOn(surface, gestureAxis, delta)) return;

    push(delta);
    apply();
    startLoop();
  }

  /**
   * Fix what this bounce moves, holds and anchors — once, while nothing is
   * translated yet, so every measurement is of the real layout. Returns false
   * when the surface cannot bounce without breaking something, in which case
   * nothing was changed.
   */
  function lockOn(surface: HTMLElement, ax: Axis, delta: number): boolean {
    // Move the viewport's content layers, not the viewport itself. A viewport
    // with no element children (only text/pseudo content) has nothing to
    // bounce safely, so we skip rather than fall back to moving the box.
    const pinned = pinnedElements(surface, ax);
    const candidates = contentLayers(surface);
    const layers = candidates.filter((c) => !pinned.includes(c));
    if (layers.length === 0) return false;

    // A push toward the start (scrolling down/right at the end) shortens a
    // scrollable surface's range unless something holds its end in place.
    let end: HTMLElement | null = null;
    if (delta > 0 && scrollRange(surface, ax) > 0) {
      end = anchorExtent(surface, ax);
      if (end === null) return false;
    }

    el = surface;
    axis = ax;
    targets = layers.map((node) => toLayer(node, ax));
    held = pinned
      .filter((p) => !candidates.includes(p))
      .map((node) => ({ node, at: edgeOf(node, ax) }));
    anchor = end;
    return true;
  }

  /**
   * Add a wasted scroll delta as outward displacement. Scrolling down/right at a
   * dead end nudges content UP/LEFT (positive delta → negative offset), like
   * native overscroll. Resistance shrinks the contribution as we near the limit.
   */
  function push(delta: number): void {
    const resistance = 1 - Math.abs(offset) / MAX_PULL;
    offset += -delta * PUSH_FACTOR * resistance;
    if (offset > MAX_PULL) offset = MAX_PULL;
    else if (offset < -MAX_PULL) offset = -MAX_PULL;
  }

  function apply(): void {
    if (targets.length === 0) return;
    for (const t of targets) moveLayer(t, axis, offset);
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
  }

  function startLoop(): void {
    if (loopId === null) {
      lastTs = null;
      loopId = requestAnimationFrame(step);
    }
  }

  function step(ts: number): void {
    loopId = null;
    if (!el) return;

    const dt = lastTs === null ? 16 : Math.min(MAX_FRAME_MS, ts - lastTs);
    lastTs = ts;

    // Finger down → hold the current displacement; otherwise spring back.
    if (!touching) {
      offset *= Math.exp(-dt / DECAY_TAU_MS);
      if (Math.abs(offset) < STOP_EPS) {
        offset = 0;
        apply();
        resetSurface();
        return;
      }
    }

    apply();
    loopId = requestAnimationFrame(step);
  }

  function resetSurface(): void {
    if (loopId !== null) {
      cancelAnimationFrame(loopId);
      loopId = null;
    }
    for (const t of targets) restoreLayer(t);
    for (const h of held) h.node.style.translate = "";
    anchor?.remove();
    targets = [];
    held = [];
    anchor = null;
    el = null;
    offset = 0;
    lastTs = null;
  }

  function pickScrollSurface(start: Element | null, ax: Axis): Element | null {
    const overflowProp = ax === "x" ? "overflow-x" : ("overflow-y" as const);
    let node: Element | null = start;
    while (node) {
      const overflow = getComputedStyle(node).getPropertyValue(overflowProp);
      if (SCROLLABLE_OVERFLOW.has(overflow.trim())) return node;
      node = node.parentElement;
    }
    // Fallback chain: nearest pane → main → scrolling root.
    const pane = start?.closest("[data-pane-id]");
    if (pane) return pane;
    const main = document.querySelector("main");
    if (main) return main;
    return document.scrollingElement ?? document.documentElement;
  }

  function onWheel(event: WheelEvent): void {
    if (event.ctrlKey) return; // pinch-zoom, not a scroll
    recordGesture(event, event.deltaX, event.deltaY, event.target);
  }

  function onScroll(): void {
    if (pending) pending.scrolledSince = true;
  }

  function onTouchStart(event: TouchEvent): void {
    const t = event.touches[0];
    if (!t) return;
    touching = true;
    touchStartX = t.clientX;
    touchStartY = t.clientY;
  }

  function onTouchMove(event: TouchEvent): void {
    const t = event.touches[0];
    if (!t) return;
    // Finger up = content scrolls down, so delta is inverted to match wheel sign.
    const deltaX = touchStartX - t.clientX;
    const deltaY = touchStartY - t.clientY;
    touchStartX = t.clientX;
    touchStartY = t.clientY;
    recordGesture(event, deltaX, deltaY, event.target);
  }

  function onTouchEnd(): void {
    // Finger released → resume the spring-back from wherever it was held.
    touching = false;
    if (el) startLoop();
  }

  window.addEventListener("wheel", onWheel, { passive: true });
  window.addEventListener("scroll", onScroll, { capture: true, passive: true });
  window.addEventListener("touchstart", onTouchStart, { passive: true });
  window.addEventListener("touchmove", onTouchMove, { passive: true });
  window.addEventListener("touchend", onTouchEnd, { passive: true });
  window.addEventListener("touchcancel", onTouchEnd, { passive: true });

  return () => {
    window.removeEventListener("wheel", onWheel);
    window.removeEventListener("scroll", onScroll, { capture: true });
    window.removeEventListener("touchstart", onTouchStart);
    window.removeEventListener("touchmove", onTouchMove);
    window.removeEventListener("touchend", onTouchEnd);
    window.removeEventListener("touchcancel", onTouchEnd);
    if (rafId !== null) cancelAnimationFrame(rafId);
    resetSurface();
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

/**
 * Whether any scroller the gesture could chain through — `start` and its
 * ancestors — can still move in the gesture's direction on `axis`.
 */
function hasRoomToScroll(
  start: Element | null,
  axis: Axis,
  delta: number,
): boolean {
  for (let node = start; node; node = node.parentElement) {
    if (!(node instanceof HTMLElement)) continue;
    const style = getComputedStyle(node);
    const overflow = axis === "y" ? style.overflowY : style.overflowX;
    if (!SCROLLABLE_OVERFLOW.has(overflow)) continue;
    const range = scrollRange(node, axis);
    if (range <= 0) continue;
    const at = Math.abs(axis === "y" ? node.scrollTop : node.scrollLeft);
    if (delta > 0 ? at < range - 1 : at > 1) return true;
  }
  return false;
}

/** How far `surface` can scroll on `axis` (0 when its content fits). */
function scrollRange(surface: HTMLElement, axis: Axis): number {
  return axis === "y"
    ? surface.scrollHeight - surface.clientHeight
    : surface.scrollWidth - surface.clientWidth;
}

/**
 * Hold `surface`'s scroll extent on `axis` while its content is translated
 * toward the start, or return null when that cannot be done.
 *
 * Scrollable overflow counts a transformed box where it is drawn, so content
 * pushed up by N px ends N px sooner: the range shrinks by N, and at the end
 * edge — the only place such a push happens — the browser clamps the scroll
 * offset back by N. The bounce then cancels itself out, and as it decays the
 * range grows back under an offset that stays put, leaving the page N px short
 * of its end. An untransformed, invisible element after the last child, sized to
 * reach exactly the current end, keeps the end where it was.
 *
 * Sized, not merely placed last: the end is often not where the last child's
 * box ends — a pane's `h-full` content box is one viewport tall while the page
 * overflows out of it. Whether it holds is measured, not assumed: unless it
 * reaches the extent exactly and adds none of its own on either axis, it is
 * removed and the bounce is skipped — a missing bounce is cosmetic, a scrolled
 * page is not.
 */
function anchorExtent(surface: HTMLElement, axis: Axis): HTMLElement | null {
  const style = getComputedStyle(surface);
  const height = surface.scrollHeight;
  const width = surface.scrollWidth;
  const extent = axis === "y" ? height : width;
  const end = document.createElement("div");
  end.setAttribute("aria-hidden", "true");
  end.style.cssText =
    "display:block;flex:none;width:0;height:0;margin:0;padding:0;border:0;pointer-events:none;visibility:hidden";
  // A flex or grid container puts its gap in front of every item, this one included.
  const rowGap = parseFloat(style.rowGap);
  const columnGap = parseFloat(style.columnGap);
  if (rowGap > 0) end.style.marginTop = `${-rowGap}px`;
  if (columnGap > 0) end.style.marginLeft = `${-columnGap}px`;
  surface.appendChild(end);

  // Where the anchor's far edge lands, in the surface's scroll coordinates.
  const reach = (): number => {
    const box = end.getBoundingClientRect();
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
  const short = extent - reach();
  if (short > 0) {
    end.style[axis === "y" ? "height" : "width"] = `${short}px`;
  }
  const holds =
    Math.abs(reach() - extent) <= 1 &&
    Math.abs(surface.scrollHeight - height) <= 1 &&
    Math.abs(surface.scrollWidth - width) <= 1;
  if (!holds) {
    end.remove();
    return null;
  }
  return end;
}
