import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { Theme, type ThemeProps, type ThemeSurface } from "./internal/theme";
export { PopupTheme, type PopupThemeProps } from "./internal/popup-theme";
export { useEnclosingAppThemeScope } from "./internal/app-theme-scope";
export {
  useColorScheme,
  usePublishColorScheme,
  usePublishedColorScheme,
} from "./internal/color-scheme";
export {
  ColorSchemeRegion,
  type ColorSchemeRegionProps,
} from "./internal/color-scheme-region";

export default {
  description:
    "Theme-boundary primitive: <Theme name surface> is the one element that says 'everything below here wears theme X', complete — the data-theme-scope attribute, the PortalThemeScopeProvider that carries it across portals, the colour scheme its scope wears (data-color-scheme, published by the theme engine, forwarded to popups; useColorScheme reads the nearest region's in JS), and the canvas it paints, which no site can now forget because `surface` is required. <ColorSchemeRegion scheme> is a region that always wears one scheme (the image viewer's dark). And <PopupTheme name>: the popups opened from a region wear theme X while the region keeps its own. Plus the no-adhoc-theme-scope lint rule that keeps the three halves from being hand-assembled apart again.",
  contributions: [],
} satisfies PluginDefinition;
