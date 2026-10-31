import {
  createContext,
  useContext,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";

/**
 * The container the nearest {@link PortalHost} draws popups into. `null`
 * outside any host: the popup library then uses its own default, `body`.
 */
const PortalContainerContext =
  createContext<RefObject<HTMLElement | null> | null>(null);

/**
 * Makes every popup opened inside it — popover, menu, select, tooltip, dialog —
 * render INSIDE this region instead of at the end of `document.body`.
 *
 * Needed wherever `body` is not on screen, or not on top: an element handed to
 * the Fullscreen API (the browser then paints only that element's subtree, so
 * a popup under `body` is invisible), or an overlay stacked above the popup
 * layer. Wrap the region's contents; the host adds one empty element after
 * them, which the popups are drawn into.
 *
 * The region must be a positioning context with no transform, so the popups'
 * own positioning still resolves against the viewport.
 *
 * Nested hosts: a popup uses its NEAREST host. A popup opened from inside a
 * hosted popup lands in the same host (the context crosses portals).
 */
export function PortalHost({
  children,
  className,
}: {
  children: ReactNode;
  /** Classes for the host element — e.g. `pointer-events-auto` when the region
   *  is `pointer-events-none`, so the popups drawn into it stay clickable. */
  className?: string;
}): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <PortalContainerContext.Provider value={ref}>
      {children}
      <div ref={ref} data-portal-host="" className={className} />
    </PortalContainerContext.Provider>
  );
}

/**
 * The container a popup portals into: the nearest {@link PortalHost}'s, or
 * `undefined` (the library's default, `body`) outside any host. Handed as a
 * ref, which the library resolves when the popup opens — after the host has
 * mounted. Called by the ui-kit portal wrappers; a feature plugin wraps a region
 * in `PortalHost` instead.
 */
export function usePortalContainer():
  RefObject<HTMLElement | null> | undefined {
  return useContext(PortalContainerContext) ?? undefined;
}
