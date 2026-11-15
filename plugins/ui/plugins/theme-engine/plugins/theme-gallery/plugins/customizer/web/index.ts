import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ThemeCustomizer } from "@plugins/ui/plugins/theme-engine/plugins/theme-customizer/web";
import {
  SelectedThemeSummary,
  ThemeGalleryPicker,
  useThemeSectionMatchesSearch,
} from "@plugins/ui/plugins/theme-engine/plugins/theme-gallery/web";
import { symbol } from "@plugins/ui/plugins/icons/core";

export default {
  description:
    "The Theme customizer section: the theme gallery as cards, with rename and delete on saved themes.",
  contributions: [
    ThemeCustomizer.Section({
      companion: true,
      id: "themes",
      label: "Theme",
      icon: symbol("palette"),
      component: ThemeGalleryPicker,
      summary: SelectedThemeSummary,
      useAvailable: useThemeSectionMatchesSearch,
      // The picker is what most visits to the pane are for.
      useDefaultOpen: () => true,
    }),
  ],
} satisfies PluginDefinition;
