import { useLayoutEffect, useRef, type RefObject } from "react";
import { useResizeObserverSet } from "@plugins/primitives/plugins/dom/plugins/element-size/web";
import { playOverlayEnter } from "./enter";
import { prefersReducedMotion } from "./reduced-motion";
import { SIZE_EASING, SIZE_MS } from "./size-motion";

/** A flow item's laid-out top-left, relative to its container's, with no
 *  transform in it (neither a running glide nor an enter's scale). */
interface Point {
  x: number;
  y: number;
}

interface Flow {
  el: HTMLElement | null;
  /** The container's laid-out children, in DOM order. */
  items: HTMLElement[];
  /** Every item's last recorded layout position — the next glide's start. */
  pos: WeakMap<HTMLElement, Point>;
  /** The container and every `display: contents` box between it and its
   *  items: a child added or removed under one of these changes the flow. */
  boxes: Set<Node>;
  mutations: MutationObserver | null;
  /** Starts a size watch on one element (the container or an item); its
   *  report re-records every position. Set while attached. */
  observe: ((el: Element) => () => void) | null;
  /** The release of each element watched now. */
  watched: Map<Element, () => void>;
  /** The container's width at the last record. */
  width: number;
  /** Inside `watchSizes`: a new watch's synchronous first report is not a
   *  resize — the positions were just recorded. */
  watching: boolean;
}

/** The boxes the container lays out: its children, looking through
 *  `display: contents` wrappers (a slot's item box), skipping what generates
 *  no box or is out of the flow. Records the wrappers on the way. */
function flowItems(container: HTMLElement, boxes: Set<Node>): HTMLElement[] {
  boxes.clear();
  boxes.add(container);
  const items: HTMLElement[] = [];
  const walk = (parent: Element): void => {
    for (const child of parent.children) {
      if (!(child instanceof HTMLElement)) continue;
      const style = getComputedStyle(child);
      if (style.display === "contents") {
        boxes.add(child);
        walk(child);
      } else if (
        style.display !== "none" &&
        style.position !== "absolute" &&
        style.position !== "fixed"
      ) {
        items.push(child);
      }
    }
  };
  walk(container);
  return items;
}

/** The `translate` currently drawn on `el` (a running glide's, added onto
 *  any of its own). */
function drawnTranslate(el: HTMLElement): Point {
  const raw = getComputedStyle(el).translate;
  if (!raw || raw === "none") return { x: 0, y: 0 };
  const [x = "0", y = "0"] = raw.split(" ");
  return { x: Number.parseFloat(x) || 0, y: Number.parseFloat(y) || 0 };
}

/** `el`'s layout position: the drawn box's centre (which a scale about the
 *  centre never moves) less the drawn translate, back to the top-left by the
 *  layout size (`offset*`, immune to transforms). */
function layoutPoint(el: HTMLElement, origin: DOMRect): Point {
  const rect = el.getBoundingClientRect();
  const t = drawnTranslate(el);
  return {
    x: rect.left + rect.width / 2 - t.x - el.offsetWidth / 2 - origin.left,
    y: rect.top + rect.height / 2 - t.y - el.offsetHeight / 2 - origin.top,
  };
}

function sameItems(a: HTMLElement[], b: HTMLElement[]): boolean {
  return a.length === b.length && a.every((el, i) => el === b[i]);
}

function canAnimate(el: HTMLElement): boolean {
  return typeof el.animate === "function";
}

/** Slides `el` from `dx, dy` away back to its place. Additive, so a glide
 *  that starts while another runs carries on from where the item is drawn. */
function glide(el: HTMLElement, dx: number, dy: number): void {
  el.animate([{ translate: `${dx}px ${dy}px` }, { translate: "0px 0px" }], {
    duration: SIZE_MS,
    easing: SIZE_EASING,
    composite: "add",
  });
}

/** Records every item's layout position, moving nothing — the flow's resting
 *  state (a first attach, a resize). */
function record(f: Flow, el: HTMLElement): void {
  f.width = el.offsetWidth;
  const origin = el.getBoundingClientRect();
  for (const item of f.items) f.pos.set(item, layoutPoint(item, origin));
}

/** Watches the container and exactly the current items. Run once their
 *  positions are recorded: a first watch reports at once, and its re-record
 *  must not overwrite the positions a glide starts from. */
function watchSizes(f: Flow, el: HTMLElement): void {
  const observe = f.observe;
  if (observe === null) return;
  const keep = new Set<Element>([el, ...f.items]);
  f.watching = true;
  for (const [watched, release] of f.watched) {
    if (keep.has(watched)) continue;
    release();
    f.watched.delete(watched);
  }
  for (const target of keep) {
    if (!f.watched.has(target)) f.watched.set(target, observe(target));
  }
  f.watching = false;
}

function unwatchSizes(f: Flow): void {
  for (const release of f.watched.values()) release();
  f.watched.clear();
}

/** The set of items changed (one shown, hidden, added, moved): each new item
 *  enters, each that kept its place in the DOM but not on screen glides from
 *  its last position to its new one. */
function onFlowChange(f: Flow): void {
  const el = f.el;
  if (el === null) return;
  const items = flowItems(el, f.boxes);
  if (sameItems(items, f.items)) return;
  f.items = items;
  const origin = el.getBoundingClientRect();
  // A container that changed width since the last record reflowed in this
  // same frame (a window resize whose report has not landed yet, which also
  // changes a grid's pad): the recorded positions are the old layout's, so
  // nothing glides from them.
  const reflowed = el.offsetWidth !== f.width;
  f.width = el.offsetWidth;
  // Every read first, then every animation: starting one invalidates style,
  // so interleaving them would recalc it once per item.
  const moves = items.map((item) => {
    const now = layoutPoint(item, origin);
    const before = f.pos.get(item);
    f.pos.set(item, now);
    return { item, now, before };
  });
  if (!prefersReducedMotion()) {
    for (const { item, now, before } of moves) {
      if (!canAnimate(item)) continue;
      if (before === undefined) {
        // The overlay enter, `Presence`'s, read in the container's scope.
        playOverlayEnter(item, el);
        continue;
      }
      if (reflowed) continue;
      const dx = before.x - now.x;
      const dy = before.y - now.y;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      glide(item, dx, dy);
    }
  }
  watchSizes(f, el);
}

/**
 * Moves the children of the element `target` holds when the SET of them
 * changes, instead of letting them jump: an item that newly appears (a detail
 * section shown, a tile added) fades and scales in, and every item it — or
 * one that left — displaced glides from where it was to where it now is.
 * `enabled` false watches nothing.
 *
 * - The items are the container's laid-out children, seen through
 *   `display: contents` wrappers (a render slot's item box), so a slot-drawn
 *   stack works as is. Only a child added, removed or moved under the
 *   container or one of those wrappers counts — a change deeper inside an
 *   item never re-measures the flow.
 * - A `MutationObserver` sees the change after the commit, before the frame's
 *   layout: positions are read there and every animation starts from the old
 *   one, so the first frame drawn is already continuous. The before-positions
 *   are the ones recorded at the last change or size report — a resize (an
 *   item opening, the window) re-records them without moving anything.
 * - Glides animate `translate` additively, so one that starts mid-glide
 *   carries on from where the item is drawn; the enter is the overlay token
 *   group's, the one `Presence` plays. A leaving item just goes — use
 *   `Presence` for an exit.
 * - Nothing moves on the first attach, nor under reduced motion.
 */
export function useFlowMotion(
  target: RefObject<HTMLElement | null>,
  enabled: boolean,
): void {
  const flow = useRef<Flow>({
    el: null,
    items: [],
    pos: new WeakMap(),
    boxes: new Set(),
    mutations: null,
    observe: null,
    watched: new Map(),
    watching: false,
    width: 0,
  });
  // A size report — an item opening, the window resizing — re-records every
  // position and moves nothing (RAF-batched by the primitive).
  const observe = useResizeObserverSet(() => {
    const f = flow.current;
    if (f.el !== null && !f.watching) record(f, f.el);
  });
  // After each commit: follow whatever element the ref names now (a remount
  // starts a fresh flow, drawn at rest; the same element keeps its own).
  useLayoutEffect(() => {
    const f = flow.current;
    const el = enabled ? target.current : null;
    if (f.el === el) return;
    f.mutations?.disconnect();
    unwatchSizes(f);
    f.el = el;
    f.items = [];
    f.pos = new WeakMap();
    f.mutations = null;
    f.observe = observe;
    if (el === null) return;
    f.items = flowItems(el, f.boxes);
    record(f, el);
    const mutations = new MutationObserver((records) => {
      if (records.some((r) => f.boxes.has(r.target))) onFlowChange(f);
    });
    mutations.observe(el, { childList: true, subtree: true });
    f.mutations = mutations;
    watchSizes(f, el);
  });
  useLayoutEffect(() => {
    const f = flow.current;
    return () => {
      f.mutations?.disconnect();
      unwatchSizes(f);
      f.el = null;
    };
  }, []);
}
