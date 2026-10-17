import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { FontFamily } from "@plugins/ui/plugins/tokens/plugins/font-family/web";
import { GoogleFontsLoader } from "./internal/google-fonts-loader";

export default {
  description:
    "Loads the Google Fonts that the theme each scope selects asks for (the desktop's and every app's own), so a per-app font loads whether or not that app is focused.",
  contributions: [
    FontFamily.Root({ component: GoogleFontsLoader, companion: true }),
  ],
} satisfies PluginDefinition;
