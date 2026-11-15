import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ThemeCustomizer } from "@plugins/ui/plugins/theme-engine/plugins/theme-customizer/web";
import {
  ColorAdjustSection,
  useColorAdjustMatchesSearch,
} from "./components/color-adjust-section";

export default {
  description:
    'Customizer section for a theme\'s color adjustment — the hue / saturation / lightness shift applied to every color it paints — with "Fill from…" shortcuts.',
  contributions: [
    ThemeCustomizer.Section({
      companion: true,
      id: "color-adjust",
      label: "Color Adjust",
      component: ColorAdjustSection,
      // Section doesn't answer the search box ⇒ no card, rather than a bar over nothing.
      useAvailable: useColorAdjustMatchesSearch,
    }),
  ],
} satisfies PluginDefinition;
