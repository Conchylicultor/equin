import {
  defineFixedTheme,
  type FixedTheme,
} from "@plugins/ui/plugins/theme-engine/core";
import type { MapTileScheme } from "../../core";

/**
 * The theme the map's own chrome wears — everything drawn OVER the tiles
 * rather than on the app's surface: the renderer's Fit control, the empty
 * notice, a host's floating controls, and the tooltips and popovers they open.
 *
 * One per tile scheme, keyed on it, so a renderer's `tiles` declaration picks
 * the chrome as it already picks its pins' label ink: Google's light tiles
 * under a dark app get light controls, never dark pills on a light map.
 *
 * Fixed themes (not sub-themes): the chrome must read the scheme's whole
 * palette whatever the surrounding app's theme is — a sub-theme names a few
 * tokens and inherits the rest from the app, so every other colour would stay
 * dark — and a tooltip opened from a control over the tiles is more of the
 * map's chrome (a fixed theme's popups keep it; a sub-theme's leave). They
 * name no tokens: the schema defaults' light (or dark) half is a neutral
 * chrome over any basemap.
 */
export const mapChromeThemes: Record<MapTileScheme, FixedTheme> = {
  light: defineFixedTheme({
    id: "map-chrome-light",
    label: "Map controls (light tiles)",
    scheme: "light",
    fragments: [],
  }),
  dark: defineFixedTheme({
    id: "map-chrome-dark",
    label: "Map controls (dark tiles)",
    scheme: "dark",
    fragments: [],
  }),
};
