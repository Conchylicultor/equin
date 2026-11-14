import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Apps } from "@plugins/apps-core/web";
import { ThemeEngine } from "@plugins/ui/plugins/theme-engine/web";
import { isleApp } from "../core";
import { IsleLayout } from "./components/isle-layout";
import { isleTheme } from "./internal/theme";

export default {
  description:
    "The Isle app's rail entry and frame: a chromeless full-pane surface where the world view's index pane is shown, and the app's light-only theme naming its two faces (Nunito, Fraunces) so the font loader fetches them.",
  contributions: [
    Apps.App({ app: isleApp, component: IsleLayout }),
    // Selected for the isle app in `config/ui/theme-engine/@app/isle/theme.jsonc`.
    ThemeEngine.Theme(isleTheme),
  ],
} satisfies PluginDefinition;
