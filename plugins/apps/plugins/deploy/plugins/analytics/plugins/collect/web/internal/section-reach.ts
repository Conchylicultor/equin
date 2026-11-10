import { useEffect, useRef, type RefObject } from "react";
import { createInViewWatcher } from "@plugins/primitives/plugins/dom/plugins/in-view/web";
import { track } from "./instance";
import { SECTION_REACH_EVENT, SECTION_REACH_PROP } from "../../core";

/**
 * Records `section_reach` once when `el` first reaches the upper half of the
 * screen — the visitor scrolled far enough to be reading it, not merely to see
 * its top edge peek in. A section taller than the screen counts as soon as its
 * top passes the middle, so a long band is not missed for never fitting.
 *
 * `section` is `<page>/<key>` (`landing/hero`, `vision/idea`): a prop value is
 * reported across every path, so the page is part of it.
 *
 * Once per observation: the observer disconnects after it fires, and returns a
 * disposer for a section unmounted before it is reached. A page shown again
 * mounts again, and is a new pageview, so it counts again.
 */
export function observeSectionReach(el: Element, section: string): () => void {
  const watcher = createInViewWatcher(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      watcher.disconnect();
      track(SECTION_REACH_EVENT, { [SECTION_REACH_PROP]: section });
    },
    // the viewport, clipped by every scrolling ancestor (the pane included),
    // with its lower half cut off
    { rootMargin: "0px 0px -50% 0px" },
  );
  watcher.observe(el);
  return () => watcher.disconnect();
}

/** {@link observeSectionReach} for a React element: attach the returned ref to the section. */
export function useSectionReach<T extends Element>(
  section: string,
): RefObject<T | null> {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el)
      throw new Error(
        `[analytics] useSectionReach("${section}"): ref not attached`,
      );
    return observeSectionReach(el, section);
  }, [section]);
  return ref;
}
