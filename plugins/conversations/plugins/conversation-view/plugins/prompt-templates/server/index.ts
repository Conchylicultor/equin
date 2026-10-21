import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2 } from "@plugins/config_v2/server";
import { promptTemplatesConfig } from "../shared/config";

export default {
  description:
    "Named template chips that prepend text to the conversation prompt editor for editing before sending.",
  contributions: [
    ConfigV2.Register({ descriptor: promptTemplatesConfig }),
  ],
  portable: true,
} satisfies ServerPluginDefinition;
