import { Toaster as Sonner } from "sonner";
import {
  chromeTheme,
  chromeThemeScope,
} from "@plugins/apps-core/plugins/chrome-theme/web";
import { useElementSize } from "@plugins/primitives/plugins/dom/plugins/element-size/web";
import { Theme } from "@plugins/primitives/plugins/css/plugins/theme-boundary/web";
import { ViewportOverlay } from "@plugins/primitives/plugins/css/plugins/viewport-overlay/web";
import { DismissAllButton } from "./dismiss-all-button";
import { useToastsSuppressed } from "../internal/suppress-toasts";
import { usePublishReaderAudience } from "../internal/reader-audience";
import { ToastLayer } from "../internal/layer";

/**
 * Sonner's own `VIEWPORT_OFFSET` default, restated here because the stack-action
 * strip has to land on the exact same corner inset as the toast stack it sits
 * under. Kept as one number for both viewports so the vertical geometry is
 * identical everywhere (sonner's narrower mobile inset still applies sideways).
 */
const VIEWPORT_OFFSET = 24;
/** Breathing room between the strip and the front toast above it. */
const STACK_GAP = 8;

export function ToasterHost() {
  usePublishReaderAudience();
  // A surface that shows no toasts (the menu-bar panel) is mounted.
  if (useToastsSuppressed()) return null;
  return <Toasts />;
}

function Toasts() {
  const [actionsRef, { height: actionsHeight }] =
    useElementSize<HTMLDivElement>();

  // The strip is a reserved band, not an overlay: the stack's own bottom offset
  // grows by exactly what the strip measures, so the actions can never paint
  // over the front toast — and cost nothing (0px) while the strip is empty.
  // Measuring rather than hardcoding a height keeps the control's own density
  // tokens the single source of the reservation.
  const reserved = actionsHeight > 0 ? actionsHeight + STACK_GAP : 0;

  return (
    // The stack and its dismiss-all strip share ONE layer, so no other surface
    // on the stack (the Ask card) can land between them — drawn, like every
    // stack surface, through ViewportOverlay, whose PortalHost makes a popup
    // opened from a toast (a notification's Fix popover) paint above the
    // toasts rather than on the popover layer beneath them. The overlay mounts
    // nothing until the layer's place is known — never a guessed z-index the
    // toasts would then jump off. That loses no toast: sonner (>= 2.0.8)
    // replays every still-active toast to a `<Toaster>` when it subscribes, so
    // one fired before the host mounts shows the moment it does (pinned in
    // toast-ledger.test.tsx). The root is click-through: only the toasts and
    // the strip's button take clicks.
    <ViewportOverlay layer={ToastLayer} className="pointer-events-none">
      {/* Sonner renders its toast list inline (a fixed-position `<ol
          data-sonner-toaster>`, not a React portal), so the `var(--popover)` /
          `var(--border)` / `var(--radius)` in the style prop resolve from this
          wrapper's theme scope. Toasts are chrome: they wear the chrome's
          fixed theme, the same whichever app is focused — and so sonner's own
          light/dark styling follows the chrome's scheme, not the page's color
          mode.

          `surface="none"` is the honest no-paint case the role exists for,
          not an omission: everything under here is an overlay-level card (a
          toast, the dismiss-all strip) that paints itself and is
          fixed-positioned out of this wrapper's flow. A canvas here would be
          an opaque sheet over the whole app. */}
      <Theme name={chromeThemeScope} surface="none">
        <Sonner
          theme={chromeTheme.scheme}
          className="toaster group pointer-events-auto"
          offset={{ bottom: VIEWPORT_OFFSET + reserved }}
          mobileOffset={{ bottom: VIEWPORT_OFFSET + reserved }}
          style={
            {
              // Sonner's own stylesheet pins the list at z-index 999999999;
              // inside the layer that would paint it over the popups the
              // layer hosts. `auto` leaves it at the layer's own level, under
              // them.
              zIndex: "auto",
              "--normal-bg": "var(--popover)",
              "--normal-text": "var(--popover-foreground)",
              "--normal-border": "var(--border)",
              "--border-radius": "var(--radius)",
            } as React.CSSProperties
          }
        />
        <div
          ref={actionsRef}
          // eslint-disable-next-line layout/no-adhoc-layout -- viewport-corner fixed strip, anchored to the same inset as sonner's own fixed toast list
          className="fixed"
          style={{ right: VIEWPORT_OFFSET, bottom: VIEWPORT_OFFSET }}
        >
          <DismissAllButton />
        </div>
      </Theme>
    </ViewportOverlay>
  );
}
