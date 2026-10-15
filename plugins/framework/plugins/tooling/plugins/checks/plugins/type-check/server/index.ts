import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { spawnTypeCheckWorker } from "./internal/spawn-worker";
export type { TypeCheckWorkerRun } from "./internal/spawn-worker";

export default {
  description:
    "spawnTypeCheckWorker: the one way to start a repo-program type-check worker — admitted through the laned host-wide type-check-worker pool (background may hold one slot, the interactive lane the other) and the holder's grant, demoted only for a background-lane holder.",
} satisfies ServerPluginDefinition;
