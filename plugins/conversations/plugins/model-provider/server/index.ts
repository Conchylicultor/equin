import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2 } from "@plugins/config_v2/server";
import { modelProviderConfig } from "../shared/config";

export default {
  description:
    "Model ids, families and choices: the id grammar every concrete version follows (flag, label and family derive from the id alone), the catalog shape and its pure readers (resolveModel, choiceHint, selectableChoices), and the model-provider config.",
  contributions: [ConfigV2.Register({ descriptor: modelProviderConfig })],
} satisfies ServerPluginDefinition;
