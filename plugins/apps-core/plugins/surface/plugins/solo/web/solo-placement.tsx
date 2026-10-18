import type { PlacementDef } from "@plugins/apps-core/plugins/surface/web";
import { symbol } from "@plugins/ui/plugins/icons/core";

const fullscreenIcon = symbol("fullscreen");

/**
 * The solo (fullscreen) surface mode: only the focused tab, full-viewport. It
 * asks for the `viewport` frame, which is the whole statement: the host both
 * positions the container against the window and drops the `transform` off its
 * backdrop while this mode is active, so the box resolves against the viewport
 * instead of the content area (the exact mechanics, and why the frame's z-band
 * is `z-overlay` and not `z-max`, live on `FRAME_CLASS` in the host). The tab
 * itself does not move: the container stays exactly where it is in the tree,
 * which is what keeps the app inside it mounted (its scroll, its edits, its
 * iframes).
 *
 * Mutual exclusion with windows mode is guaranteed one level up, structurally:
 * the surface is in exactly ONE mode, and each mode renders every tab under its
 * own descriptor. Solo does not set `visibleWhenUnfocused`, so only the focused
 * tab is painted and it declares no Backdrop/Foreground — so entering solo drops
 * the desktop wallpaper + window dock. There is simply no window to overlap it.
 */
export const soloDef: PlacementDef = {
  id: "solo",
  label: "Fullscreen (solo)",
  icon: fullscreenIcon,
  order: 2,
  // The boot mode: a fresh session opens one app edge to edge. Esc (or the
  // mode control) leaves it for the previous mode, else the first other one.
  default: true,
  frame: "viewport",
  // A single app fills the viewport, so `:root` carries the app's theme (like
  // docked, unlike floating's multi-window backdrop) — see useRootThemeScope.
  themeScope: "app",
  ownsChrome: true,
  // No frame chrome: a fullscreen tab is edge to edge, and its canvas comes from
  // the host's `<Theme surface="canvas">` container like every other mode's.
  // The way out is the global action bar, which floats over the top-right
  // corner in this mode (its gear holds the mode control), plus Esc.
};
