import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { spawnTypeCheckWorker } from "./internal/spawn-worker";
export type {
  TypeCheckWorkerRun,
  WorkerAdmission,
} from "./internal/spawn-worker";

export default {
  description:
    "spawnTypeCheckWorker: the one way to start a repo-program type-check worker — admitted first as a small run through the laned type-check-light pool (its worker refuses any program over TYPE_CHECK_LIGHT_SOURCES), else — or once refused — through the laned type-check-worker pool (background may hold one slot, the interactive lane the other), then the holder's grant; the worker runs in the foreground as the slot's holder.",
} satisfies ServerPluginDefinition;
