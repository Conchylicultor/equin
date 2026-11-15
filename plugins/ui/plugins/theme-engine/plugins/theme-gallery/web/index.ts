import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { QuickTheme } from "@plugins/ui/plugins/theme-engine/plugins/quick-theme/web";
import { QuickThemePicker } from "./components/theme-pickers";
import {
  DeleteThemeAction,
  RenameThemeAction,
  ThemeItemActions,
} from "./components/theme-item-actions";

export {
  SelectedThemeSummary,
  ThemeGalleryPicker,
  useThemeSectionMatchesSearch,
} from "./components/theme-pickers";

export default {
  description:
    "The Theme DataView: every selectable theme plus every catalog's unsaved entries, with My themes / Community / Curated views. Picking one selects it for the current scope (saving a catalog entry first). Shown in the quick-theme popover (compact rows) and, through the `customizer` child, as the customizer's first section (cards, with rename and delete on saved themes).",
  contributions: [
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
