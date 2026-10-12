import { defineTheme, lightOnly } from "@plugins/ui/plugins/theme-engine/core";
import { categoricalGroup } from "@plugins/ui/plugins/tokens/plugins/categorical/core";
import { colorPaletteGroup } from "@plugins/ui/plugins/tokens/plugins/color-palette/core";
import { richTextPaletteGroup } from "@plugins/ui/plugins/tokens/plugins/rich-text-palette/core";
import { sidebarPaletteGroup } from "@plugins/ui/plugins/tokens/plugins/sidebar-palette/core";

/**
 * The Places app's own theme — light only. The map's tiles are light whatever
 * the mode, so the app around them is too: every group with a dark variant
 * wears its light defaults in both modes (`lightOnly`). Selected for the app in
 * `config/ui/theme-engine/@app/places/theme.jsonc`. A group it does not mention
 * paints that group's schema defaults.
 */
export const placesTheme = defineTheme({
  id: "places",
  label: "Places",
  fragments: [
    lightOnly(colorPaletteGroup),
    lightOnly(sidebarPaletteGroup),
    lightOnly(categoricalGroup),
    lightOnly(richTextPaletteGroup),
  ],
});
