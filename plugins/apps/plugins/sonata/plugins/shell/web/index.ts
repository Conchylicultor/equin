import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Apps } from "@plugins/apps-core/web";
import { ThemeEngine } from "@plugins/ui/plugins/theme-engine/web";

import { appIcon } from "@plugins/apps-core/plugins/app-icon/core";
import { sonataApp } from "../core";
import { SonataLayout } from "./components/sonata-layout";
import { Sonata } from "./slots";
import { sonataTheme } from "./internal/theme";
import { symbol } from "@plugins/ui/plugins/icons/core";

export {
  Sonata,
  SonataSectionItem,
  SonataSectionStack,
  useSonataSectionOpen,
} from "./slots";
export type { SonataSection } from "./slots";
export { useSonataApp, type SonataAppValue } from "./app";
export {
  LaneInsetsProvider,
  useLaneInsets,
  type LaneInsets,
} from "./lane-insets";

export default {
  description:
    "App shell for Sonata. Registers the /sonata app entry (SonataLayout: one SonataPlayerScope around the pane router), derives the app's song — the one loaded in the player (useSonataApp) — and defines the app-level Sonata.{Overlay,TransportOverlay,TransportEdge,PitchAxis,Home,Effect,Hud,ViewOption,Section} slots, and the app's own dark-only theme (the immersive player's blue-black night, sky accent, the chord colours, Manrope), which the sonata app selects.",
  contributions: [
    Apps.App({
      app: sonataApp,
      icon: appIcon(symbol("piano")),
      component: SonataLayout,
    }),
    // Selected for the sonata app in `config/ui/theme-engine/@app/sonata/theme.jsonc`.
    ThemeEngine.Theme(sonataTheme),
  ],
  slots: { ...Sonata },
} satisfies PluginDefinition;
