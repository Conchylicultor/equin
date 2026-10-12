import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Apps } from "@plugins/apps-core/web";
import { appIcon } from "@plugins/apps-core/plugins/app-icon/core";
import { ThemeEngine } from "@plugins/ui/plugins/theme-engine/web";
import { chordApp } from "../core";
import { ChordLayout } from "./components/chord-layout";
import { ChordLogo } from "./components/chord-logo";
import { chordTheme } from "./internal/theme";
import { symbol } from "@plugins/ui/plugins/icons/core";

export default {
  description:
    "The Chord app's rail entry and frame: the standard sidebar-less app shell around the full-pane renderer, where the trainer's pane (whose header carries the app launcher) is shown, and the app's own dark-only theme (the mockup's onyx blacks, the seven chord colours and the neutral grey as the chord-palette tokens, Schibsted Grotesk and Bodoni Moda), which the chord app selects.",
  contributions: [
    Apps.App({
      app: chordApp,
      icon: appIcon(symbol("queue-music")),
      mark: ChordLogo,
      component: ChordLayout,
    }),
    // Selected for the chord app in `config/ui/theme-engine/@app/chord/theme.jsonc`.
    ThemeEngine.Theme(chordTheme),
  ],
} satisfies PluginDefinition;
