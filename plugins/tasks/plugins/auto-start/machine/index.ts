import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { autoStartDroppedSweepWarmup } from "./internal/dropped-sweep";

export default {
  description:
    "Auto-start, desktop-only half: the boot warm-up that clears leftover auto-launch markers from already-dropped tasks (a host-scoped warm-up, which only a backend process drains).",
  register: [autoStartDroppedSweepWarmup],
} satisfies MachinePluginDefinition;
