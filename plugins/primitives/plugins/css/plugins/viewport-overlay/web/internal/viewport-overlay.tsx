import { useCallback, useRef, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  cn,
  usePortalForwardedAttrs,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type { Passthrough } from "@plugins/primitives/plugins/passthrough/core";
import {
  type PortaledLayer,
  zLayerClass,
} from "@plugins/primitives/plugins/css/plugins/z-layers/web";
import {
  useZStackIndex,
  type ZStackLayer,
} from "@plugins/primitives/plugins/css/plugins/z-layers/plugins/stack/web";
import { foldResource } from "@plugins/primitives/plugins/live-state/web";
import { PortalHost } from "@plugins/primitives/plugins/overlay/plugins/portal-host/web";
import { useViewportEscape } from "./use-viewport-escape";

// The viewport-fill recipe lives in a module const (not an inline className
// literal) so the `no-adhoc-viewport-overlay` rule — which only harvests literals
// reached from a className attribute subtree — never flags the primitive that
// owns it. Same trick `<Card>`/`<Surface>` use to stay clear of their own lint.
const OVERLAY_ROOT = "fixed inset-0";

/**
 * The passthrough ({@link Passthrough}) lands on the portal root div, `ref`
 * included. The `fixed inset-0` + z-layer + `data-theme-scope` are owned by the
 * primitive and cannot be overridden away.
 */
/** Everything but the layer — what the overlay root itself takes. */
interface OverlayBodyProps extends Passthrough<HTMLDivElement> {
  /** Extra classes for the overlay root (background, flex layout, etc.). */
  className?: string;
  /** Inline style for the overlay root; a stack layer's z-index wins over it. */
  style?: CSSProperties;
  children: ReactNode;
}

export interface ViewportOverlayProps extends OverlayBodyProps {
  /**
   * Stacking layer. Defaults to "popover" (the documented portaled-layer). An
   * app-wide surface that must paint above the popovers passes its own declared
   * stack layer (`ZStack.Layer`, z-layers/stack) — never a generic one.
   */
  layer?: PortaledLayer | ZStackLayer;
}

/**
 * The sanctioned home for a viewport-filling overlay (fullscreen modes, picker
 * and draw overlays, modal scrims). Self-portals to `document.body` so its
 * `fixed inset-0` box is relative to the real VIEWPORT — never to a
 * `transform-gpu` (or any transform / filter / will-change) ancestor that would
 * otherwise become the containing block and silently clip it to the content
 * area. Re-stamps the portal-forwarded `data-*` bag (theme scope, plugin
 * lineage, pane id) via `usePortalForwardedAttrs()` so ancestry-derived signals
 * survive the portal hop — themed content keeps the originating surface's palette
 * and the element-picker still resolves the owning plugin.
 *
 * Why this exists: several app surfaces deliberately transform a container to
 * scope `position: fixed` chrome; any hand-rolled `fixed inset-0` descendant is
 * then clipped with no error. Routing every viewport overlay through this
 * primitive makes that whole class of bug structurally impossible — enforced by
 * the co-located `no-adhoc-viewport-overlay` lint rule.
 *
 * The portal is a POSITIONING mechanism, not a mount-retention one, and there is
 * deliberately no prop to turn it off. React reconciles a portal by container
 * identity, so putting one behind a condition — `cond ? createPortal(…) : …`, or
 * a container that changes — deletes the subtree and builds a new one. This
 * overlay always portals, always into `document.body`, so its subtree survives
 * its own rerenders; a caller who needs a subtree to survive a LAYOUT change
 * needs something else entirely (see the co-located
 * `web/__tests__/portal-toggle-remounts.test.tsx` and the
 * `no-portal-toggle` rule).
 */
export function ViewportOverlay({
  layer = "popover",
  ...props
}: ViewportOverlayProps) {
  return typeof layer === "string" ? (
    <OverlayRoot layerClass={zLayerClass(layer)} name={layer} {...props} />
  ) : (
    <StackOverlay layer={layer} {...props} />
  );
}

/**
 * A stack layer: its z-index comes from the committed stack order, and its
 * children draw their own popups — a popup portaled to `<body>` sits on the
 * popover layer, BELOW this overlay, so a tooltip inside it would be hidden.
 * The host element is `pointer-events-auto` so popups stay clickable under a
 * `pointer-events-none` overlay root.
 *
 * Nothing is drawn until the stack order is known: a guessed z-index would put
 * the overlay under (or over) the wrong neighbour and then move it. The portal
 * therefore first mounts once the index is known and is never toggled after —
 * a refresh that fails keeps the last-known index (`stale`), the same element.
 * A first read that fails draws nothing; the failed read itself is reported by
 * live-state.
 */
function StackOverlay({
  layer,
  children,
  ...props
}: OverlayBodyProps & { layer: ZStackLayer }) {
  const zIndex = foldResource(useZStackIndex(layer), {
    loading: () => null,
    error: (_error, stale) => stale ?? null,
    ready: (z) => z,
  });
  if (zIndex === null) return null;
  return (
    <OverlayRoot name={layer.id} zIndex={zIndex} {...props}>
      <PortalHost className="pointer-events-auto">{children}</PortalHost>
    </OverlayRoot>
  );
}

function OverlayRoot({
  layerClass,
  zIndex,
  name,
  className,
  children,
  ref,
  style,
  ...rest
}: OverlayBodyProps & {
  layerClass?: string;
  zIndex?: number;
  name: string;
}) {
  const forwarded = usePortalForwardedAttrs();
  // The audit below needs a real ref OBJECT to read after commit, and the caller
  // needs the same node — so the two compose onto one callback rather than one
  // of them winning. (`ref` used to be written after `{...rest}`, which quietly
  // threw the caller's away: the primitive kept the node it addressed.)
  const rootRef = useRef<HTMLDivElement>(null);
  const setRoot = useCallback(
    (el: HTMLDivElement | null) => {
      rootRef.current = el;
      if (typeof ref === "function") ref(el);
      else if (ref) ref.current = el;
    },
    [ref],
  );

  // The one failure this primitive's design cannot make impossible. Portaling to
  // `<body>` escapes every ancestor INSIDE the app — that is the whole point —
  // but it cannot escape `body` and `html` themselves. A global `filter` or
  // `transform` there (a blur-while-locked scrim, a devtools frame, a browser
  // extension that wraps the page) is still a containing block for this box, and
  // the overlay is then clipped with no error, exactly like the ad-hoc `fixed
  // inset-0` this primitive exists to replace.
  //
  // `from: "parent"` because this element IS the fixed box: a `position: fixed`
  // element is its own stacking context, so an inclusive walk would report the
  // overlay against itself every time. Dev only — outside dev there is nobody to
  // fix it while the page is open, and the walk is not free.
  useViewportEscape(rootRef, {
    enabled: !!import.meta.env.DEV,
    from: "parent",
    subject: `a <ViewportOverlay layer="${name}">`,
    remedy:
      "Remove the property from <body> / <html>, or scope it to a subtree that does not contain the portal root.",
  });

  return createPortal(
    <div
      {...forwarded}
      // eslint-disable-next-line viewport-overlay/no-adhoc-viewport-overlay -- OVERLAY_ROOT is THE viewport-fill recipe this rule redirects everyone else to; the primitive owns it
      className={cn(OVERLAY_ROOT, layerClass, className)}
      style={zIndex === undefined ? style : { ...style, zIndex }}
      {...rest}
      // After the passthrough, like the class recipe above it — but the caller's
      // `ref` is not lost to that, it is COMPOSED into `setRoot`. The primitive's
      // own audit cannot be spread away, and the caller still reaches the node
      // its attributes landed on.
      ref={setRoot}
    >
      {children}
    </div>,
    document.body,
  );
}
