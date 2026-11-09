import { Pane, defineRoute } from "@plugins/primitives/plugins/pane/web";
import { settingsApp } from "@plugins/apps/plugins/settings/plugins/shell/core";
import { ThemeCustomizerBody } from "./components/theme-customizer";

/**
 * The customizer opens inside whichever app you are currently in — it styles
 * that app's theme scope — so callers compose
 * `activeApp.path + themeCustomizerRoute.path({})` rather than one fixed link.
 * Keeping the segment here rather than inline at call sites means a rename
 * still propagates to every link.
 *
 * Being openable anywhere is NOT the same as having no home: Appearance is a
 * Settings surface, so `app` is `settingsApp` and Expand takes the customizer
 * to Settings, where it lives on its own. The in-place, restyle-what-you-see
 * usage is the popover/side-pane one, which Expand does not disturb.
 */
export const themeCustomizerRoute = defineRoute({
  id: "theme-customizer",
  segment: "theme-customizer",
});

export const themeCustomizerPane = Pane.define({
  route: themeCustomizerRoute,
  app: settingsApp,
  title: "Theme Customizer",
  component: ThemeCustomizerBody,
});
