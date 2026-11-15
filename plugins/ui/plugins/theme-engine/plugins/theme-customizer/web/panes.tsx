import { Pane } from "@plugins/primitives/plugins/pane/web";
import { themeCustomizerRoute } from "../core";
import { settingsApp } from "@plugins/apps/plugins/settings/plugins/shell/core";
import { ThemeCustomizerBody } from "./components/theme-customizer";

/**
 * Being openable anywhere (see `themeCustomizerRoute`) is NOT the same as
 * having no home: Appearance is a Settings surface, so `app` is `settingsApp`
 * and Expand takes the customizer to Settings, where it lives on its own. The
 * in-place, restyle-what-you-see usage is the popover/side-pane one, which
 * Expand does not disturb.
 */
export const themeCustomizerPane = Pane.define({
  route: themeCustomizerRoute,
  app: settingsApp,
  title: "Theme Customizer",
  component: ThemeCustomizerBody,
});
