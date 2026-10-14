import { useCallback, useEffect, useRef } from "react";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";

export interface RevealOptions {
  behavior?: ScrollBehavior;
  block?: ScrollLogicalPosition;
  inline?: ScrollLogicalPosition;
  /**
   * Which scroll containers may move. `"all"` (the default, native
   * `scrollIntoView`) scrolls every ancestor that has to; `"nearest"` scrolls
   * only the element's closest scroll container — for a list floating inside a
   * larger surface (a HUD over a canvas) whose own position must never shift.
   */
  scope?: "all" | "nearest";
}

/** The closest ancestor that scrolls on `axis`, or null. */
function scrollContainer(el: Element): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const { overflowX, overflowY } = getComputedStyle(p);
    if (/auto|scroll/.test(overflowY) || /auto|scroll/.test(overflowX)) {
      return p;
    }
  }
  return null;
}

/** How far `container` scrolls on one axis to put `[start, end)` (in its
 *  viewport coordinates, `size` long) at `position`. */
function delta(
  start: number,
  end: number,
  size: number,
  position: ScrollLogicalPosition,
): number {
  switch (position) {
    case "start":
      return start;
    case "end":
      return end - size;
    case "center":
      return (start + end - size) / 2;
    case "nearest":
      if (start < 0) return start;
      if (end > size) return Math.min(start, end - size);
      return 0;
  }
}

function revealInNearest(
  el: Element,
  opts: Required<Omit<RevealOptions, "scope">>,
) {
  const container = scrollContainer(el);
  if (!container) return;
  const box = container.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  container.scrollBy({
    top: delta(
      r.top - box.top,
      r.bottom - box.top,
      container.clientHeight,
      opts.block,
    ),
    left: delta(
      r.left - box.left,
      r.right - box.left,
      container.clientWidth,
      opts.inline,
    ),
    behavior: opts.behavior,
  });
}

/**
 * Imperative form for genuine event handlers and effects with a bespoke re-fire
 * key (click-to-scroll TOC, a `[line, html]` deep-link effect). The thin
 * sanctioned wrapper over `el.scrollIntoView` — the one funnel the
 * `no-adhoc-scroll-into-view` lint rule allows, and the single home for any
 * future cross-cutting reveal policy.
 */
export function revealElement(
  el: Element | null | undefined,
  opts?: RevealOptions,
): void {
  if (!el) return;
  const resolved = {
    behavior: opts?.behavior ?? "auto",
    block: opts?.block ?? "nearest",
    inline: opts?.inline ?? "nearest",
  };
  if (opts?.scope === "nearest") revealInNearest(el, resolved);
  else el.scrollIntoView(resolved);
}

/**
 * Scrolls the attached element into view when `isActive` TRANSITIONS false→true
 * while mounted. Never fires because the element remounted already-active — that
 * is the entire point of the primitive: background data churn (a live-state push
 * remounting a selected row) must never move the user's scroll.
 *
 * `revealOnMount` opts into ONE reveal on mount when mounting already-active
 * (deep-link / new-tab cases). Pass a function for a lazily-consumed one-shot
 * intent (the tree's initial-mount reveal): it is called exactly once, only when
 * mounting already-active.
 */
export function useRevealOnActive(
  isActive: boolean,
  opts?: RevealOptions & { revealOnMount?: boolean | (() => boolean) },
): (el: HTMLElement | null) => void {
  const elRef = useRef<HTMLElement | null>(null);
  // `null` until the first effect run — distinguishes mount from a transition.
  const prevActiveRef = useRef<boolean | null>(null);
  // Latest options read inside the effect without widening its dep set.
  const optsRef = useLatestRef(opts);

  const setRef = useCallback((el: HTMLElement | null) => {
    elRef.current = el;
  }, []);

  useEffect(() => {
    const prev = prevActiveRef.current;
    prevActiveRef.current = isActive;
    const options = optsRef.current;
    if (prev === null) {
      // First run after mount. Reveal only if mounting already-active AND the
      // caller opted in; the one-shot function is consumed here, not otherwise.
      if (!isActive) return;
      const wants = options?.revealOnMount;
      if (typeof wants === "function" ? wants() : (wants ?? false)) {
        revealElement(elRef.current, options);
      }
      return;
    }
    // Later runs: an activation transition is the only trigger.
    if (!prev && isActive) revealElement(elRef.current, options);
  }, [isActive]);

  return setRef;
}
