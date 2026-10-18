import { defineApp } from "@plugins/primitives/plugins/pane/core";

/**
 * The desktop — the floating-window surface mode, as an app. It has a name,
 * an icon, an entry in every app launcher, its own `app:desktop` theme and
 * config scope and its one data dir, like any app; what it does NOT have is a
 * tab: picking it switches the surface to {@link DESKTOP_PLACEMENT_ID} (its
 * `Apps.App` entry is a `surfaceMode` launch), and its windows are the shell's
 * ordinary in-app tabs. `basePath` is never routed — a surface-mode app is kept
 * out of URL matching (`isTabApp`).
 */
export const desktopApp = defineApp({
  id: "desktop",
  name: "Desktop",
  basePath: "/desktop",
  iconKey: "desktop-windows",
});

/**
 * The `Surface.Placement` id the desktop's windows plugin contributes. Kept
 * `"floating"` — the id persisted surface modes already hold — and authored
 * here, with the identity, so the shell's app entry and the windows plugin's
 * placement name the same mode without importing each other.
 */
export const DESKTOP_PLACEMENT_ID = "floating";
