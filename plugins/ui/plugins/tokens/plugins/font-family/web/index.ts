import {
  Core,
  type PluginDefinition,
} from "@plugins/framework/plugins/web-sdk/core";
import { ThemeEngine } from "@plugins/ui/plugins/theme-engine/web";
import { fontFamilyGroup } from "../core";
import { FontFamily } from "./slots";

export { FontFamily } from "./slots";

export default {
  description:
    "Font-family token group (sans/serif/mono families, letter-spacing). Its customizer section is the `customizer` child.",
  contributions: [
    ThemeEngine.TokenGroup({
      id: "font-family",
      label: "Fonts",
      descriptor: fontFamilyGroup,
    }),
    Core.Root({ slot: FontFamily.Root }),
  ],
  slots: FontFamily,
} satisfies PluginDefinition;
