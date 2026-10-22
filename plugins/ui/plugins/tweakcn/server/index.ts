import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { importTweakcnTheme } from "../core/endpoints";
import { handleImport } from "./internal/handle-import";

export default {
  portable: true,
  description:
    "Imports tweakcn themes by id: fetches one from tweakcn.com, converts it into token-group fragments, and saves it as a saved theme.",
  httpRoutes: {
    [importTweakcnTheme.route]: handleImport,
  },
} satisfies ServerPluginDefinition;
