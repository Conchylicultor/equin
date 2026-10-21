import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2 } from "@plugins/config_v2/server";
import { themeSelectionConfig } from "../core";
import { themeDocumentHead } from "./internal/document-head";

export { ThemeEngine } from "./internal/source";
export type { ServerThemeSource } from "./internal/source";

export default {
  description:
    "Registers the theme selection config, and paints the first frame: renders every app's theme CSS into the SPA shell's head (DocumentHead.Fragment) from the generated theme declarations, the ThemeEngine.Source themes and the selections, re-rendered when any of them changes.",
  contributions: [
    ConfigV2.Register({ descriptor: themeSelectionConfig }),
    themeDocumentHead,
  ],
  portable: true,
} satisfies ServerPluginDefinition;
