import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { checkCachePruneJob } from "./internal/prune-job";

export default {
  description:
    "The hourly checks.cache-prune job: ages out and caps the shared check-result cache and reclaims idle flight files, so no check run lists the whole cache.",
  register: [checkCachePruneJob],
} satisfies ServerPluginDefinition;
