import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { webArtifactsPruneJob } from "./internal/prune-job";

export default {
  description:
    "The hourly web-artifacts.prune job: prunes the shared write-once web caches (artifact store, vendor sets, CSS cache, package assets) off every build's path — dist links read unlocked, only changed dists re-read under the store lock.",
  register: [webArtifactsPruneJob],
} satisfies ServerPluginDefinition;
