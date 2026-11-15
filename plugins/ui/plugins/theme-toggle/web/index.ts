import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { QuickTheme } from "@plugins/ui/plugins/theme-engine/plugins/quick-theme/web";
import { ThemeToggle } from "./components/theme-toggle";

export default {
  description:
    "Light/dark controls: the Dark mode and Match system switches inside the quick-theme popover (editing the scheme of the focused app's scope, or the global setting when no app fills the surface). Its Color mode customizer section is the `customizer` child.",
  contributions: [
    QuickTheme.Section({
      id: "color-mode",
      label: "Appearance",
      component: ThemeToggle,
    }),
  ],
} satisfies PluginDefinition;
