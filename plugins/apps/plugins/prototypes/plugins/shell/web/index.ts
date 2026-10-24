import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Apps } from "@plugins/apps-core/web";

import { prototypesApp } from "../core";
import { PrototypesLayout } from "./components/prototypes-layout";
import { ThemeEngine } from "@plugins/ui/plugins/theme-engine/web";
import { prototypesTheme } from "./internal/theme";

export default {
  description:
    "App shell for Prototypes. Registers the /prototypes app entry and renders the gallery + detail panes (the gallery, and the canvas of frames) full-surface: opening a prototype replaces the gallery, whose header leads with Back. Contributes the app's own theme (prototypes: the viewer mockup's neutral greys, apricot accent, Geist, its radii and shadows, the floating-chrome glass and the prototypes icon family).",
  contributions: [
    Apps.App({
      app: prototypesApp,
      component: PrototypesLayout,
    }),
    ThemeEngine.Theme(prototypesTheme),
  ],
} satisfies PluginDefinition;
