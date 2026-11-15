import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ThemeCustomizer } from "@plugins/ui/plugins/theme-engine/plugins/theme-customizer/web";
import {
  ColorModeSection,
  useColorModeMatchesSearch,
} from "./components/color-mode-section";

export default {
  description:
    "The Color mode customizer section: the current app's color mode (its declared default or an override) and the global setting.",
  contributions: [
    ThemeCustomizer.Section({
      companion: true,
      id: "color-mode",
      label: "Color mode",
      component: ColorModeSection,
      useAvailable: useColorModeMatchesSearch,
    }),
  ],
} satisfies PluginDefinition;
