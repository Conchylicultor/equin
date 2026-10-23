import { useContext, useLayoutEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  cn,
  usePortalForwardedAttrs,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  type InTreeLayer,
  zLayerClass,
} from "@plugins/primitives/plugins/css/plugins/z-layers/web";
import type { Passthrough } from "@plugins/primitives/plugins/passthrough/core";
import { SurfaceOverlayHostContext } from "./surface-overlay-host";

// The surface-fill recipe lives in a module const (not an inline className
// literal) so the layout rules — which only harvest literals reached from a
// className attribute subtree — never flag the primitive that owns them. Same
// trick `<ViewportOverlay>`/`<Card>`/`<Surface>` use to stay clear of their own
// lint.
const SURFACE_OVERLAY_ROOT = "absolute inset-0";

/**
 * The passthrough ({@link Passthrough}) lands on the portal root div, `ref`
 * included — mirrors `<ViewportOverlay>`. The `absolute inset-0` + z-layer are
 * owned by the primitive and cannot be overridden away. (The `display: contents`
 * container the root portals INTO is not that node: it generates no box, so
 * there is nothing there to address.)
 */
export interface SurfaceOverlayProps extends Passthrough<HTMLDivElement> {
  /** Stacking layer, within the surface. Defaults to "overlay" (the top in-tree
   *  level) — an overlay that covers the surface must out-stack the pane chrome
   *  it covers, but stays UNDER every portaled layer, so dialogs and menus
   *  opened from inside it still paint above it. */
  layer?: InTreeLayer;
  /** Extra classes for the overlay root (background, flex layout, etc.). */
  className?: string;
  children: ReactNode;
}

/**
 * The sanctioned home for a **surface-filling** overlay: a box that covers the
 * app tab's whole surface — everything below the tab bar and right of the app
 * rail — while the app chrome around it stays visible and usable.
 *
 * Why a portal at all. The caller is somewhere down a pane tree: a Miller
 * column, a scroll body, a card. `absolute inset-0` there fills that column,
 * not the surface, and no combination of classes at the call site can reach
 * past an ancestor that is `overflow-hidden` or `relative`. So the overlay is
 * rendered into the nearest `<SurfaceOverlayHost>` instead, which is the only
 * box that IS the surface.
 *
 * How it differs from its two neighbours:
 *
 * - `<ViewportOverlay>` fills the WINDOW (portals to `document.body`), so it
 *   covers the rail and the tab bar too. That is right for a modal scrim or a
 *   fullscreen mode and wrong whenever the user must keep switching tabs.
 * - `<Layer>` / `<Overlay>` fill their own PARENT and cannot escape it — they
 *   are in-flow positioning, with no portal. Right when the box you want to
 *   cover is the box you are already in.
 *
 * The container is minted once and never replaced. React reconciles a portal by
 * container identity, so a container that changes (or a portal put behind a
 * condition) deletes the subtree and builds a new one — an `<iframe>` inside
 * would reload, an uncommitted edit would be gone. The same idiom, and the same
 * reason, as `primitives/adaptive-bar`'s `PortaledBarItem`; the co-located
 * `no-portal-toggle` rule bans the conditional shape.
 *
 * A missing host throws. There is no viewport fallback and no silent no-op:
 * "covers the surface" and "covers the window" are different pictures, and a
 * primitive that quietly delivers the second one when the first is unavailable
 * is a bug that only shows up in a screenshot.
 */
export function SurfaceOverlay({
  layer = "overlay",
  className,
  children,
  ...rest
}: SurfaceOverlayProps) {
  const forwarded = usePortalForwardedAttrs();
  const host = useContext(SurfaceOverlayHostContext);

  // `display: contents` generates no box, so this node is neither a containing
  // block nor a flex/grid item: the portaled root's `absolute inset-0` resolves
  // against the HOST's `relative` box, exactly as if it were rendered there.
  const [container] = useState(() => {
    const el = document.createElement("div");
    el.style.display = "contents";
    return el;
  });

  // Layout effect, not `useEffect`: the container is attached before the
  // browser paints, so the overlay never flashes as a detached (invisible)
  // subtree for one frame.
  useLayoutEffect(() => {
    if (!host) {
      throw new Error(
        "<SurfaceOverlay> needs a <SurfaceOverlayHost> ancestor — the box it fills. " +
          "Every app tab has one (apps-core/tab-surface); if you are rendering outside a " +
          "tab surface, use <ViewportOverlay> (fills the window) or <Layer> (fills its own parent).",
      );
    }
    return host.attach(container);
  }, [host, container]);

  return createPortal(
    <div
      {...forwarded}
      className={cn(SURFACE_OVERLAY_ROOT, zLayerClass(layer), className)}
      {...rest}
    >
      {children}
    </div>,
    container,
  );
}
