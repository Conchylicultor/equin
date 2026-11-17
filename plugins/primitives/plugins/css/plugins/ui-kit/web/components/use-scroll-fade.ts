import { useLayoutEffect, useState } from "react";

import { afterLayout } from "@plugins/primitives/plugins/dom/plugins/after-layout/web";
import { useResizeObserver } from "@plugins/primitives/plugins/dom/plugins/element-size/web";
import { useEventCallback } from "@plugins/primitives/plugins/latest-ref/web";

export interface ScrollFade<T extends HTMLElement> {
  /**
   * Callback ref for the scroller. A caller that also has its own ref composes
   * the two itself — this hook never writes to a ref it was handed (the React
   * Compiler forbids mutating a hook argument, and the composition belongs in
   * the component that owns the `ref` prop anyway).
   */
  measureRef: (node: T | null) => void;
  /** Wire to the scroller's `onScroll`. */
  onScroll: () => void;
  /** There is content above the visible window. */
  top: boolean;
  /** There is content below the visible window. */
  bottom: boolean;
}

/**
 * The measurement half of the `scroll-edge-fade` utility (app.css): tells a scroller
 * whether there is more content above / below what it is currently showing.
 *
 * The paint is pure CSS — two sticky pseudo-elements gated on `data-fade-top` /
 * `data-fade-bottom`. All this hook decides is when those attributes are on, and
 * the ONLY honest answer is a measurement: a fade that is always on claims
 * content that isn't there, which is worse than no signal at all.
 *
 * Three signals feed it, because scroll alone is not enough — the "Turn into"
 * and `/` block menus filter their lists as the user types, so scrollable-ness
 * changes with no scroll event ever firing:
 *
 *  1. **scroll** — the returned `onScroll`.
 *  2. **resize** — a `ResizeObserver` on the scroller (through the sanctioned
 *     `element-size` primitive). A clamped panel whose list filters down shrinks;
 *     one that refills grows back. This is the filter case.
 *  3. **every commit** — a layout effect with no dependency list. It closes the
 *     gap the other two leave: content appended while the box is ALREADY at its
 *     height cap changes `scrollHeight` without resizing the box or moving the
 *     scroll position. Commit-driven, not a poll, and the setter bails out on an
 *     unchanged pair so it can never loop. The effect only QUEUES the read
 *     (`afterLayout`): read on the commit path, `scrollHeight` forces a
 *     synchronous style + layout of the whole dirty document there (on a pane
 *     scroller, a long page opening beside a conversation measured ~110 ms of
 *     it). Queued, it runs with the frame's other layout reads, still before
 *     paint.
 *
 * The node is held in state rather than a ref (the `useElementSize` precedent):
 * the measurement is render-visible, so it must re-subscribe the observer when
 * the node changes.
 */
export function useScrollFade<T extends HTMLElement>(): ScrollFade<T> {
  const [node, setNode] = useState<T | null>(null);
  const [state, setState] = useState({ top: false, bottom: false });

  const measure = useEventCallback(() => {
    if (!node) return;
    // 1px of slack at both ends: fractional line boxes, browser zoom and
    // `alignItemWithTrigger`'s percentage sizing routinely leave
    // `scrollTop + clientHeight` a hair short of `scrollHeight` at the true end
    // of a list — without the slack that paints a permanent bottom fade on a
    // panel already fully scrolled, and on Select, whose panel doesn't scroll
    // here at all (base-ui makes its inner list the scroller).
    const top = node.scrollTop > 1;
    const bottom = node.scrollTop + node.clientHeight < node.scrollHeight - 1;
    setState((prev) =>
      prev.top === top && prev.bottom === bottom ? prev : { top, bottom },
    );
  });

  useResizeObserver(() => node, measure, { deps: [node] });
  // Intentionally no dependency list — see signal 3 above.
  useLayoutEffect(() => afterLayout(measure));

  return {
    measureRef: setNode,
    onScroll: measure,
    top: state.top,
    bottom: state.bottom,
  };
}
