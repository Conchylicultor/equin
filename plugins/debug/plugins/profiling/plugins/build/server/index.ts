import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { handleBuildDetail } from "./internal/handle-build-detail";
import { getBuildRunProfileByWorktree } from "../shared/endpoints";

export default {
  description:
    "Build step profiling data endpoint: one build run's profile, by worktree and build id.",
  httpRoutes: {
    [getBuildRunProfileByWorktree.route]: handleBuildDetail,
  },
} satisfies ServerPluginDefinition;
