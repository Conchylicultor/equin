import { createContext, useContext, useState, type ReactNode } from "react";

/**
 * The element the nearest {@link PortalHost} draws popups into: the element
 * itself, `null` while the host has not mounted it yet, or — no provider —
 * outside any host.
 */
const PortalContainerContext = createContext<HTMLElement | null | undefined>(
  undefined,
);

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
  // The element, not a ref to it: the popup library resolves a ref's
  // `.current` only when its portal mounts, so a popup already open on the
  // host's first commit — mounted before the host element after it is
  // attached — read `null` and fell back to `body` for good. As state, the
  // element reaches every popup once it exists (and again if it is replaced).
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  return (
    <PortalContainerContext.Provider value={element}>
      {children}
      <div ref={setElement} data-portal-host="" className={className} />
    </PortalContainerContext.Provider>
  );
}

/**
 * Re-provides a host's element to content rendered in ANOTHER part of the
 * React tree than the host but shown inside it — content raised from its own
 * render origin (`scope/render-origin`) into a hosted region (a toast's body,
 * in the toast layer), whose popups must still be drawn in that region.
 * `container` is the host element as `usePortalContainer()` read it there.
 */
export function PortalContainerProvider({
  container,
  children,
}: {
  container: HTMLElement | null | undefined;
  children: ReactNode;
}): ReactNode {
  return (
    <PortalContainerContext.Provider value={container}>
      {children}
    </PortalContainerContext.Provider>
  );
}

/**
 * The container a popup portals into: the nearest {@link PortalHost}'s
 * element; `null` inside a host not mounted yet, which the library reads as
 * "wait" (never `body`, where the popup would be invisible); `undefined` (the
 * library's default, `body`) outside any host. Called by the ui-kit portal
 * wrappers; a feature plugin wraps a region in `PortalHost` instead.
 */
export function usePortalContainer(): HTMLElement | null | undefined {
  return useContext(PortalContainerContext);
}
