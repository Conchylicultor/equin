import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { buildRunProfileServed } from "./internal/run-profile-value";

export default {
  description:
    "Serves build.run-profile: one build run's profiler spans, read from a worktree's build artifacts on disk and notified by a watch on the profile file.",
  contributions: [...buildRunProfileServed.declare],
} satisfies MachinePluginDefinition;
