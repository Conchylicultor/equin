import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ThemeCustomizer } from "@plugins/ui/plugins/theme-engine/plugins/theme-customizer/web";
import { QuickTheme } from "@plugins/ui/plugins/theme-engine/plugins/quick-theme/web";
import {
  QuickThemePicker,
  SelectedThemeSummary,
  ThemeGalleryPicker,
  useThemeSectionMatchesSearch,
} from "./components/theme-pickers";
import {
  DeleteThemeAction,
  RenameThemeAction,
  ThemeItemActions,
} from "./components/theme-item-actions";
import { symbol } from "@plugins/ui/plugins/icons/core";

export default {
  description:
    "The Theme DataView: every selectable theme plus every catalog's unsaved entries, with My themes / Community / Curated views. Picking one selects it for the current scope (saving a catalog entry first). Shown as the customizer's first section (cards, with rename and delete on saved themes) and in the quick-theme popover (compact rows).",
  contributions: [
    ThemeCustomizer.Section({
      id: "themes",
      label: "Theme",
      icon: symbol("palette"),
      component: ThemeGalleryPicker,
      summary: SelectedThemeSummary,
      useAvailable: useThemeSectionMatchesSearch,
      // The picker is what most visits to the pane are for.
      useDefaultOpen: () => true,
    }),
    QuickTheme.Section({
      id: "themes",
      label: "Theme",
      component: QuickThemePicker,
      // A grid of theme swatches.
      needs: "picker",
    }),
    ThemeItemActions({ id: "rename", component: RenameThemeAction }),
    ThemeItemActions({ id: "delete", component: DeleteThemeAction }),
  ],
  slots: { itemActions: ThemeItemActions },
} satisfies PluginDefinition;
