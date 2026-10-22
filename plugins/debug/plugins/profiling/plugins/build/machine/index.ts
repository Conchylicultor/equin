import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { handleBuildDetail } from "./internal/handle-build-detail";
import { getBuildRunProfileByWorktree } from "../shared/endpoints";

export default {
  description:
    "Build step profiling data endpoint (needsMachine): one build run's profile, by worktree and build id, read from the worktree's build artifacts on disk.",
  httpRoutes: {
    [getBuildRunProfileByWorktree.route]: handleBuildDetail,
  },
} satisfies MachinePluginDefinition;
