import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ConfigV2 } from "@plugins/config_v2/web";
import { BackgroundMusic } from "@plugins/music/plugins/background/web";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { isleApp } from "@plugins/apps/plugins/isle/plugins/shell/core";
import { isleConfig } from "../core";
import { useIslePlayer, useIsleTitle } from "./internal/music";
import { islePane } from "./panes";

export default {
  description:
    "Isle's index pane (/isle): the island drawn by the canvas engine from the listed apps and the stored plots (apps without a plot placed by the pure world and claimed), with the title card (the product's name; Start held back while the world loads, a stage on screen past a minute or a failed claim failing into the pane's error boundary, which reports it), the where-chip, the prompt card for the building at the hero's door (E opens it), the iris an app opens through (useActivateApp), drag-and-drop of buildings (the move endpoint), the time of day from the clock or the config, and a visually hidden list of links mirroring the buildings. The island's music is a background music source (music/background): one page-lived ambient engine the view holds for its sound effects, played from the page root so it can keep playing after the island is left.",
  contributions: [
    Pane.Register({ pane: islePane }),
    ConfigV2.WebRegister({ descriptor: isleConfig }),
    BackgroundMusic.Source({
      id: "isle",
      app: isleApp,
      kind: "Ambience",
      useTitle: useIsleTitle,
      usePlayer: useIslePlayer,
    }),
  ],
  slots: { isle: islePane },
} satisfies PluginDefinition;
