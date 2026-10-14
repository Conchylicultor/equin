import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ConfigV2 } from "@plugins/config_v2/web";
import { midiFoldersConfig } from "../shared/config";
import { sourceMissingPresentation } from "./internal/presentation";

export default {
  description:
    "Watched-folder UI for the MIDI source: registers the midi-folders config (settings pane renders it for free) and presents the File field (the MIDI exposure's `sourceMissing`) that flags — and lets you filter for — folder-imported songs whose file has been deleted from disk.",
  contributions: [
    ConfigV2.WebRegister({ descriptor: midiFoldersConfig }),
    sourceMissingPresentation,
  ],
} satisfies PluginDefinition;
