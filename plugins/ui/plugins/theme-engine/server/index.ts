import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2 } from "@plugins/config_v2/server";
import { appColorModeConfig, themeSelectionConfig } from "../core";
import { themeDocumentHead } from "./internal/document-head";

export { ThemeEngine } from "./internal/source";
export type { ServerThemeSource } from "./internal/source";

export default {
  description:
    "Registers the theme selection and per-app color-mode configs, and paints the first frame: renders every app's theme CSS into the SPA shell's head (DocumentHead.Fragment) from the generated theme declarations, the ThemeEngine.Source themes, the selections and each app's effective light/dark (its declared default and the user's override), re-rendered when any of them changes.",
  contributions: [
    ConfigV2.Register({ descriptor: themeSelectionConfig }),
    ConfigV2.Register({ descriptor: appColorModeConfig }),
    themeDocumentHead,
  ],
  portable: true,
} satisfies ServerPluginDefinition;
