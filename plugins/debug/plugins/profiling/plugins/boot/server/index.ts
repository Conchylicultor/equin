import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { handleBootProfiling } from "./internal/handle-boot-profiling";
import { bootProfilingServed } from "./internal/boot-profile-served";
import { getBootProfiling } from "../core";

export default {
  description:
    "Server boot profiling data: the profiling.boot snapshot value, and its endpoint for the cold-start e2e.",
  httpRoutes: {
    [getBootProfiling.route]: handleBootProfiling,
  },
  contributions: [...bootProfilingServed.declare],
} satisfies ServerPluginDefinition;
