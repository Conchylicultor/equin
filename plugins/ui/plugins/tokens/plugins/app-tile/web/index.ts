import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ThemeEngine } from "@plugins/ui/plugins/theme-engine/web";
import { appTileGroup } from "../core";

export default {
  description:
    "App-tile token group: how intense the app tiles' colours are (app-tile-intensity) — calm on equin's launchers by default, vivid where a theme turns it up (the website).",
  contributions: [
    ThemeEngine.TokenGroup({
      id: "app-tile",
      label: "App tiles",
      descriptor: appTileGroup,
    }),
  ],
} satisfies PluginDefinition;
