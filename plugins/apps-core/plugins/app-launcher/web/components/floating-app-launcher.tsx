import { useEffect, useRef, useState, type RefObject } from "react";
import {
  placementOwnsChrome,
  usePlacementRegistry,
  useTabs,
} from "@plugins/apps-core/plugins/tabs/web";
import { chromeThemeScope } from "@plugins/apps-core/plugins/chrome-theme/web";
import { useBrandDrawnOn } from "@plugins/primitives/plugins/app-shell/web";
import { isChromelessDocument } from "@plugins/primitives/plugins/embed/web";
import { Theme } from "@plugins/primitives/plugins/css/plugins/theme-boundary/web";
import {
  cn,
  useIsMobile,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { AppLauncher } from "./app-launcher";

/** How close to its box's top-left corner (px) the pointer must come for the
 * launcher to show. */
const REVEAL_RADIUS = 96;

/**
 * Whether the pointer is within {@link REVEAL_RADIUS} of the top-left corner
 * of the box the launcher floats in — the viewport on the page, the embed's
 * box inside an `AppEmbed` (its containing block for fixed chrome) — read off
 * `corner`, a fixed zero-size marker at that corner. A window listener rather
 * than a hover zone: an invisible box over the corner would swallow clicks
 * meant for the app beneath it. Leaving the window keeps the last answer, so
 * running the pointer off the top of the page through the corner leaves the
 * launcher shown.
 */
function usePointerNearTopLeft(corner: RefObject<HTMLElement | null>): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const at = corner.current?.getBoundingClientRect();
      if (!at) return;
      setNear(
        Math.hypot(e.clientX - at.left, e.clientY - at.top) <= REVEAL_RADIUS,
      );
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => window.removeEventListener("pointermove", onMove);
  }, [corner]);
  return near;
}

/**
 * The launcher for a surface no app switcher frames, showing an app that draws
 * no brand of its own — an app with no shell chrome, like the app gallery, the
 * website or Keyboard Party. Without it such an app has no way to another:
 *
 * - solo (fullscreen) hides the app rail and tab bar;
 * - a contained tab set (an `AppEmbed`) never draws them, so there every mode
 *   that relies on them — one that does not draw its own frame (docked) — has
 *   none either. A mode that draws its own frame keeps its own answer (the
 *   desktop's shelf has a launcher; solo has none).
 *
 * Mounted at `Apps.Overlay` — inside the tab state, which switching apps
 * needs; the page's layout and every `AppEmbed` mount it — and mirroring the
 * floating action bar (top-left here, top-right there, on the same anchored
 * band), it stays hidden until the pointer nears the corner, and stays shown
 * while it holds focus or its app grid is open.
 *
 * Whether the focused surface draws the brand is read from what is mounted
 * (`useBrandDrawnOn`), never declared per app, so an app that gains or loses
 * its shell chrome needs no change here.
 */
export function FloatingAppLauncher() {
  const { focusedTabId, mode, contained } = useTabs();
  const caps = usePlacementRegistry().useValue();
  const brandDrawn = useBrandDrawnOn(focusedTabId);
  const isMobile = useIsMobile();
  // On a phone the phone action button's Apps sheet switches apps: a corner
  // launcher there would sit on the sidebar toggle.
  if (isMobile) return null;
  // Until the surface body registers, what frames the surface is not known.
  if (caps === null || brandDrawn || isChromelessDocument()) return null;
  const noSwitcher =
    mode === "solo" || (contained && !placementOwnsChrome(caps, mode));
  if (!noSwitcher) return null;
  return <RevealedLauncher />;
}

/** Its own component so the pointer listener exists only while it can show. */
function RevealedLauncher() {
  const corner = useRef<HTMLSpanElement>(null);
  const near = usePointerNearTopLeft(corner);
  return (
    // Chrome wherever it is mounted, as the floating action bar is.
    <Theme name={chromeThemeScope} surface="none">
      {/* The corner the reveal radius is measured from: the containing block's
          top-left (the viewport, or the embed's box). */}
      <span
        ref={corner}
        aria-hidden
        // eslint-disable-next-line layout/no-adhoc-layout -- a zero-size marker pinned to the fixed containing block's corner, measured by the reveal
        className="pointer-events-none fixed left-0 top-0 size-0"
      />
      {/* The band the floating action bar hangs on (`floating-bar-band` in
          app.css: centred on the surface-edge header when there is one, else
          0.5rem down), mirrored to the left edge. */}
      <div
        // eslint-disable-next-line layout/no-adhoc-layout -- viewport-edge fixed band anchored to the surface-edge header (outside any transformed ancestor), mirroring the floating action bar's
        className="floating-bar-band fixed left-3 z-popover flex flex-col"
      >
        <div
          // Hidden is BOTH transparent and not a hit target. Shown while the
          // pointer is near, the button is focused, or its grid is open (the
          // trigger's `aria-expanded`), so moving into the grid keeps it.
          // eslint-disable-next-line layout/no-adhoc-layout -- centres the launcher on the anchored band (the floating action bar's `my-auto`), with its reveal transition
          className={cn(
            "my-auto shrink-0 rounded-md bg-background shadow-sm transition-opacity duration-150",
            !near &&
              "[&:not(:focus-within,:has([aria-expanded=true]))]:pointer-events-none [&:not(:focus-within,:has([aria-expanded=true]))]:opacity-0",
          )}
        >
          <AppLauncher form="icon" tip={false} />
        </div>
      </div>
    </Theme>
  );
}
