import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export {
  withHeavyReadSlot,
  heavyReadQueueDepth,
  heavyReadSlotCount,
  heavyReadLocalSlotCount,
} from "./internal/pool";

export default {
  description:
    "Shared host-wide budget for CPU/IO-heavy git/filesystem reads: withHeavyReadSlot admits at most a few heavy reads at once across all worktree servers.",
} satisfies ServerPluginDefinition;
