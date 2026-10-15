import { both, defineSubTheme } from "@plugins/ui/plugins/theme-engine/core";
import { colorPaletteGroup } from "@plugins/ui/plugins/tokens/plugins/color-palette/core";

/**
 * The site header's two dresses on this page, from the iceberg's own palette.
 * It is pinned to the top and frosted once the page moves (`WebsiteChrome
 * headerTheme` / `headerGlass`), and wears whichever matches what is under it
 * (`IcebergSection onHeaderOver`): over the sunlit sky, the sky's dark ink on a
 * frosted white bar; once the waterline has passed its middle, light ink on a
 * frosted black one — so the nav reads on white ice and black water alike.
 *
 * The same values in both modes: the picture does not change with the mode.
 *
 * Each dress is a whole bar's palette, not just its ink: `muted` / `accent` are
 * the tone a ghost control hovers to on it (`--hover-fill`) and the panel tone
 * of anything open on it. Left out, they fall through to the site theme's
 * values for the desktop's mode — near-black under dark mode, which painted a
 * black box behind the sky's dark wordmark on hover.
 */
export const icebergSkyHeaderTheme = defineSubTheme({
  id: "iceberg-sky-header",
  label: "iceberg sky header",
  fragments: [
    colorPaletteGroup.fragment(
      both({
        background: "#f7f9fc",
        border: "rgba(11, 18, 32, 0.08)",
        foreground: "#0b1220",
        mutedForeground: "#3c4858",
        faintForeground: "#566275",
        muted: "#e8edf4",
        accent: "#e8edf4",
        accentForeground: "#0b1220",
        secondary: "#0b1220",
        secondaryForeground: "#ffffff",
      }),
    ),
  ],
});

export const icebergSeaHeaderTheme = defineSubTheme({
  id: "iceberg-sea-header",
  label: "iceberg sea header",
  fragments: [
    colorPaletteGroup.fragment(
      both({
        background: "#07090e",
        border: "rgba(255, 255, 255, 0.08)",
        foreground: "#f4f4f5",
        mutedForeground: "#b4b4bd",
        faintForeground: "#8a909c",
        muted: "#1a1e27",
        accent: "#1a1e27",
        accentForeground: "#f4f4f5",
        primaryText: "#60a5fa",
        secondary: "#f4f4f5",
        secondaryForeground: "#000000",
      }),
    ),
  ],
});
