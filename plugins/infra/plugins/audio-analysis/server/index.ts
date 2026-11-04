import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2 } from "@plugins/config_v2/server";
import { audioAnalysisConfig } from "../shared/config";

export default {
  description:
    "Audio analysis, every host's half: registers its settings (beat model, chroma variant, device) so they read and edit on every host. Analysing is the machine/ half's.",
  contributions: [ConfigV2.Register({ descriptor: audioAnalysisConfig })],
} satisfies ServerPluginDefinition;
