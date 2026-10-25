import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ActionBar } from "@plugins/shell/plugins/action-bar/web";
import { QuickThemeButton } from "./components/quick-theme-button";
import { QuickTheme } from "./slots";

export { QuickTheme } from "./slots";
export type { QuickThemeSectionContribution } from "./slots";

export default {
  description:
    "Quick-switch theme popover on the global action bar: contributed quick sections (the theme picker, the light/dark switch), every component variant picker, and a hand-off to the full customizer pane — so a theme change never costs the user their current context.",
  contributions: [
    ActionBar.Item({
      id: "quick-theme",
      component: QuickThemeButton,
      audience: "developer",
    }),
  ],
  slots: QuickTheme,
} satisfies PluginDefinition;
