import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { handleCreate } from "./internal/handle-create";
import { handleGet } from "./internal/handle-get";
import { createScreenshot, getScreenshot } from "../shared/endpoints";

export default {
  portable: true,
  description:
    "Stores in-flight screenshots (in memory) so a freshly opened tab can fetch them. Writing one to a file for an agent is the machine half's.",
  httpRoutes: {
    [createScreenshot.route]: handleCreate,
    [getScreenshot.route]: handleGet,
  },
} satisfies ServerPluginDefinition;
