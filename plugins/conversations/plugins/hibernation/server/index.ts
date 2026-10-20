import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { handleViewed } from "./internal/handle-viewed";
import { markViewed } from "../shared/endpoints";

export default {
  description:
    "Idle-conversation hibernation, portable half: the viewed endpoint that stamps lastViewedAt (resetting the idle timer).",
  portable: true,
  httpRoutes: {
    [markViewed.route]: handleViewed,
  },
} satisfies ServerPluginDefinition;
