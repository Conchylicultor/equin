import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2 } from "@plugins/config_v2/server";
import { hibernationConfig } from "@plugins/conversations/core";
import { handleViewed } from "./internal/handle-viewed";
import { markViewed } from "../shared/endpoints";

export default {
  description:
    "Idle-conversation hibernation, portable half: the global hibernation config, and the viewed endpoint that stamps lastViewedAt (resetting the idle timer).",
  portable: true,
  contributions: [ConfigV2.Register({ descriptor: hibernationConfig })],
  httpRoutes: {
    [markViewed.route]: handleViewed,
  },
} satisfies ServerPluginDefinition;
