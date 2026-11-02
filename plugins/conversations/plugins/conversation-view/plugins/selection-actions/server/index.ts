import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2 } from "@plugins/config_v2/server";
import { selectionAnswersConfig } from "../shared/config";

export default {
  description:
    "Registers the selection quick-answer list (Go, Explain, …) for Settings → Config.",
  contributions: [ConfigV2.Register({ descriptor: selectionAnswersConfig })],
} satisfies ServerPluginDefinition;
