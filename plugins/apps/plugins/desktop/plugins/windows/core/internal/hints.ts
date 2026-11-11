import { defineHint, defineHintAnchor } from "@plugins/hints/core";
import {
  appLauncherAnchor,
  appLauncherHint,
} from "@plugins/apps-core/plugins/app-launcher/core";

/** The focused window's Full screen control — the way out of the desktop
 *  into one app at a time (the solo placement). */
export const windowFullscreenAnchor = defineHintAnchor(
  "desktop.window-fullscreen",
);

/**
 * Shown the first time a window is open on the desktop: windows are a mode,
 * and the way back to one app filling the screen is this control. The app
 * launcher's "Switch apps" never shows on the desktop (the launcher asks for
 * no tip inside a surface-mode app), so this is the desktop's first tip.
 */
export const windowFullscreenHint = defineHint({
  id: "desktop.window-fullscreen",
  anchor: windowFullscreenAnchor,
  title: "Leave the desktop",
  body: "Click to show this app full screen.",
  placement: "bottom",
  order: 2,
});

/**
 * Shown on the app launcher the first time a window went full screen from the
 * desktop (`AppLauncherSlots.ReturnTip` for the desktop's mode): the launcher's
 * grid lists the Desktop, and picking it brings every window back. It replaces
 * "Switch apps" there — and for good, once shown: "Switch apps" may come
 * before it (an app opened full screen first), never after.
 */
export const backToDesktopHint = defineHint({
  id: "desktop.back-to-desktop",
  anchor: appLauncherAnchor,
  title: "Go back to the desktop",
  body: "Hover here, then pick Desktop to bring your windows back.",
  placement: "bottom",
  order: 0,
  supersedes: [appLauncherHint],
});
