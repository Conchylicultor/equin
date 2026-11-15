import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ThemeCustomizer } from "@plugins/ui/plugins/theme-engine/plugins/theme-customizer/web";
import { tokenGroupMatchesSearch } from "@plugins/ui/plugins/theme-engine/core";
import { IconsSection } from "./components/icons-section";
import { iconsGroup } from "@plugins/ui/plugins/tokens/plugins/icons/core";

export default {
  description: "Customizer section for the icons token group.",
  contributions: [
    ThemeCustomizer.Section({
      companion: true,
      id: "icons",
      label: "Icons",
      component: IconsSection,
      useAvailable: ({ search }) => tokenGroupMatchesSearch(iconsGroup, search),
    }),
  ],
} satisfies PluginDefinition;
