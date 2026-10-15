import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { boostInteractiveQos } from "./internal/spawn-priority";
export {
  readDarwinBackground,
  withForegroundPriority,
} from "./internal/darwin-background";
export type { DarwinBackground } from "./internal/darwin-background";
// Re-exported from this plugin's own core (same-plugin re-export, the rank
// pattern) so existing server-side consumers keep one import site; the impl
// lives in `core/` so core-isolated runtimes (infra/spawn, the CLI check
// runner) can compose demotion too.
export {
  backgroundArgv,
  backgroundPrefix,
} from "@plugins/packages/plugins/spawn-priority/core";

export default {
  description:
    "OS scheduling-priority isolation: backgroundArgv/backgroundPrefix wrap heavy background work (DB forks, agent sessions, builds, worktree checkouts, type-check workers) in darwinbg (taskpolicy -b) so it yields host CPU/IO to the interactive backends; boostInteractiveQos raises the calling thread to user-interactive QoS (main backend's event loop only).",
} satisfies ServerPluginDefinition;
