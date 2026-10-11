import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { handleBootProfiling } from "./internal/handle-boot-profiling";
import { getBootProfiling } from "../core";

export default {
  description: "Server boot profiling data endpoint.",
  httpRoutes: {
    [getBootProfiling.route]: handleBootProfiling,
  },
} satisfies ServerPluginDefinition;
