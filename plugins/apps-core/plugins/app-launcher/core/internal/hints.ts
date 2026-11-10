import { defineHint, defineHintAnchor } from "@plugins/hints/core";

/** The launcher button an app's own brand draws (sidebar header or top
 *  chrome) — not the floating one, which is hidden until the pointer nears
 *  its corner. */
export const appLauncherAnchor = defineHintAnchor("app-launcher.button");

/**
 * Shown the first time an app that draws its brand is open: the launcher is
 * how the user moves between apps, and nothing on it says so. First when
 * several tips come together (the desktop's Full screen tip is order 2).
 */
export const appLauncherHint = defineHint({
  id: "app-launcher.switch-apps",
  anchor: appLauncherAnchor,
  title: "Switch apps",
  body: "Hover to switch apps. Click to see them all.",
  placement: "bottom",
  order: 1,
  // Hovering it opens the grid — the very gesture the tip teaches, and the
  // grid opens where the card is: pointing at it answers the tip.
  actOn: "hover",
});
