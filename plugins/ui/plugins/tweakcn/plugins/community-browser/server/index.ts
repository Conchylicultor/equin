import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { applyCatalogTheme } from "../core/endpoints";
import { handleApply } from "./internal/handle-apply";
import { communityCatalogServed } from "./internal/resource";

export default {
  description:
    "Serves the tweakcn community catalog (the live tweakcn.community-catalog value), and the endpoint that saves one of its themes as a saved theme.",
  contributions: [...communityCatalogServed.declare],
  httpRoutes: {
    [applyCatalogTheme.route]: handleApply,
  },
} satisfies ServerPluginDefinition;
