import { defineHint, defineHintAnchor } from "@plugins/hints/core";

/** The focused window's Full screen control — the way out of the desktop
 *  into one app at a time (the solo placement). */
export const windowFullscreenAnchor = defineHintAnchor(
  "desktop.window-fullscreen",
);

/**
 * Shown the first time a window is open on the desktop: windows are a mode,
 * and the way back to one app filling the screen is this control. After the
 * app launcher's tip (order 1) when both come together — which app first,
 * then how the window is drawn.
 */
export const windowFullscreenHint = defineHint({
  id: "desktop.window-fullscreen",
  anchor: windowFullscreenAnchor,
  title: "Back to one app",
  body: "Full screen takes this window out of the desktop: its app fills the screen again, one app at a time.",
  placement: "bottom",
  order: 2,
});
