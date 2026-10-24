import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { QuickTheme } from "@plugins/ui/plugins/theme-engine/plugins/quick-theme/web";
import { ThemeCustomizer } from "@plugins/ui/plugins/theme-engine/plugins/theme-customizer/web";
import { ThemeToggle } from "./components/theme-toggle";
import {
  ColorModeSection,
  useColorModeMatchesSearch,
} from "./components/color-mode-section";

export default {
  description:
    "Light/dark controls: the Dark mode and Match system switches inside the quick-theme popover (editing the scheme of the focused app's scope, or the global setting when no app fills the surface), and a Color mode customizer section — the current app's choice (its declared default or an override) and the global setting.",
  contributions: [
    QuickTheme.Section({
      id: "color-mode",
      label: "Appearance",
      component: ThemeToggle,
    }),
    ThemeCustomizer.Section({
      id: "color-mode",
      label: "Color mode",
      component: ColorModeSection,
      useAvailable: useColorModeMatchesSearch,
    }),
  ],
} satisfies PluginDefinition;
