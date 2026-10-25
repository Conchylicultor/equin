import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { handleCreate } from "./internal/handle-create";
import { screenshotImageServed } from "./internal/store";
import { createScreenshot } from "../shared/endpoints";

export default {
  portable: true,
  description:
    "Stores in-flight screenshots (in memory) so a freshly opened tab can read them. Writing one to a file for an agent is the machine half's.",
  contributions: [...screenshotImageServed.declare],
  httpRoutes: {
    [createScreenshot.route]: handleCreate,
  },
} satisfies ServerPluginDefinition;
