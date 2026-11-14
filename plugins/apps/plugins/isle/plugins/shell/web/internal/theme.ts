import {
  both,
  defineTheme,
  lightOnly,
} from "@plugins/ui/plugins/theme-engine/core";
import { colorPaletteGroup } from "@plugins/ui/plugins/tokens/plugins/color-palette/core";
import { fontFamilyGroup } from "@plugins/ui/plugins/tokens/plugins/font-family/core";

/**
 * Nunito for the HUD and the signposts, Fraunces for map names and titles
 * (`font-serif`) — both on Google Fonts, whose loader fetches any catalogued
 * family a theme names, so the canvas can wait on `document.fonts.load` for
 * them and draw its text in them.
 */
const fontFamily = fontFamilyGroup.fragment(
  both({
    fontSans: "'Nunito', sans-serif",
    fontSerif: "'Fraunces', serif",
    fontMono: "'Cascadia Code Variable', monospace",
    letterSpacing: "0em",
    fontSmoothing: "antialiased",
  }),
);

/**
 * Isle's own theme — light only: the island is painted in daylight colours
 * and tints itself for dusk and night, so the chrome around it stays light.
 * Selected for the app in `config/ui/theme-engine/@app/isle/theme.jsonc`.
 */
export const isleTheme = defineTheme({
  id: "isle",
  label: "Isle",
  fragments: [lightOnly(colorPaletteGroup), fontFamily],
});
