import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { boostInteractiveQos } from "./internal/spawn-priority";
// Re-exported from this plugin's own core (same-plugin re-export, the rank
// pattern) so existing server-side consumers keep one import site; the impls
// live in `core/` so core-isolated runtimes (infra/spawn, the CLI check
// runner) can compose them too.
export {
  backgroundArgv,
  backgroundPrefix,
  readDarwinBackground,
  withForegroundPriority,
} from "@plugins/packages/plugins/spawn-priority/core";
export type { DarwinBackground } from "@plugins/packages/plugins/spawn-priority/core";

export default {
  description:
    "OS scheduling-priority isolation: backgroundArgv/backgroundPrefix wrap heavy background work (DB forks, agent sessions, builds, worktree checkouts) in darwinbg (taskpolicy -b) so it yields host CPU/IO to the interactive backends; spawnInForeground starts a scarce slot holder's child out of darwinbg; boostInteractiveQos raises the calling thread to user-interactive QoS (main backend's event loop only).",
} satisfies ServerPluginDefinition;
