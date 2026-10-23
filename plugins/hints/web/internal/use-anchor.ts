import { useEffect, useState, useSyncExternalStore } from "react";
import { useFocusedAppId } from "@plugins/apps-core/web";
import { autoUpdate } from "@floating-ui/react-dom";
import { resolveAnchorElement, subscribeAnchors } from "./anchor-registry";
import { rectOf, sameRect, type HintRect } from "./rect";

/**
 * The element on the page for `key` (null key or none rendered: null).
 * Re-resolved when an anchor registers or leaves, and when the focused app
 * changes — the moment a keep-alive tab's copy stops (or starts) rendering.
 */
export function useAnchorElement(key: string | null): HTMLElement | null {
  // Read for its re-render only: React calls the snapshot below on every
  // render, so a focus change re-resolves which copy is rendered.
  useFocusedAppId();
  const resolve = () => (key === null ? null : resolveAnchorElement(key));
  return useSyncExternalStore(subscribeAnchors, resolve, resolve);
}

/**
 * `el`'s viewport rect, kept current through Floating UI's `autoUpdate` — the
 * same tracker the card's placement runs on — so the spotlight, the halo and
 * the card move together: on any scroll container's scroll, a resize of the
 * element or the window, AND a layout shift that moves the element without
 * resizing it (a floating toolbar unfolding slides its buttons into place; a
 * size-only observer would leave the cut-out where the button was folded).
 * Push-based: every update answers an event.
 */
export function useTrackedRect(el: HTMLElement | null): HintRect | null {
  const [rect, setRect] = useState<HintRect | null>(null);
  useEffect(() => {
    if (!el) return;
    // The element is both the reference and the "floating" side: we track
    // one box, so its own scroll ancestors and size are all there is to watch.
    return autoUpdate(el, el, () => {
      const next = rectOf(el);
      setRect((prev) => (sameRect(prev, next) ? prev : next));
    });
  }, [el]);
  return el ? rect : null;
}
