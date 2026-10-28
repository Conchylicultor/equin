import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { compactionHookEntry } from "./internal/hook-entry";

export default {
  description:
    "The compaction-context hook, desktop-only half: compactionHookEntry — the SessionStart(compact) hook entry an agent launch merges into its settings, running the hook script beside this code by absolute path (checked on disk, so a launch never installs a hook that cannot run).",
} satisfies MachinePluginDefinition;
