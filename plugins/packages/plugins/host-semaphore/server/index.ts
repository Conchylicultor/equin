import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { createHostSemaphore } from "./internal/host-semaphore";
export type {
  AcquireHooks,
  HostSemaphore,
  HostShare,
  Priority,
  RepoLockDir,
} from "./internal/host-semaphore";

export default {
  description:
    "Cross-process concurrency primitive: createHostSemaphore bounds work across processes via flock slot files (the host-wide twin of packages/semaphore).",
} satisfies ServerPluginDefinition;
