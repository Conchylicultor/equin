import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2 } from "@plugins/config_v2/server";
import { taskDraftConfig } from "../shared/config";

export default {
  description:
    "Reusable popover + chain form for drafting one or more tasks. Powers the Improve toolbar button and the conversation new-child-task button.",
  contributions: [ConfigV2.Register({ descriptor: taskDraftConfig })],
  portable: true,
} satisfies ServerPluginDefinition;
