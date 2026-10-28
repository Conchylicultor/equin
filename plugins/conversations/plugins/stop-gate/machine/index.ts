import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { stopGateHookEntry } from "./internal/hook-entry";

export default {
  description:
    "The stop-gate hook, desktop-only half: stopGateHookEntry — the Stop hook entry an agent launch merges into its settings, running the hook script beside this code by absolute path (checked on disk, so a launch never installs a hook that cannot run).",
} satisfies MachinePluginDefinition;
