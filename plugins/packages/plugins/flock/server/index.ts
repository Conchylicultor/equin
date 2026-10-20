import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { flockTry, flockTryShared, flockRelease } from "../core/internal/flock";
export { waitForFlock } from "../core/internal/wait";
export type { HeldFlock, WaitForFlockOptions } from "../core/internal/wait";

export default {
  description:
    "Kernel advisory file locking: flockTry/flockRelease over libc flock(2), and waitForFlock — a push-based blocking acquire run in a child so the event loop never freezes. The one lock ownership the kernel releases on process death (SIGKILL included) and that consults no pid.",
} satisfies ServerPluginDefinition;
