import type { PlacementDef } from "@plugins/apps-core/plugins/surface/web";
import { symbol } from "@plugins/ui/plugins/icons/core";

const viewSidebarIcon = symbol("view-sidebar");

/**
 * The docked placement: the full-area surface — the tab "fills" the
 * surface below the tab strip and shows only when focused. No chrome, no backdrop,
 * no dynamic style, and no frame chrome either; the `pane` frame is all it needs.
 *
 * `themeScope: "app"` makes the focused docked tab's chrome wear the app theme.
 * There is no paint here any more: the host renders every tab container as a
 * `<Theme surface="canvas">`, which paints the app's own app-scoped background,
 * so a transparent region falls back to the app theme rather than to the
 * chrome/global backdrop behind it — for this mode and every other one alike.
 */
export const dockedDef: PlacementDef = {
  id: "docked",
  label: "Dock in tab strip",
  icon: viewSidebarIcon,
  themeScope: "app",
  frame: "pane",
};
