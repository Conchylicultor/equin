import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import {
  commitFilesServed,
  commitInfoServed,
  pushFilesServed,
} from "./internal/commit-values";
import { handleImageContent } from "./internal/image-handler";
import { getImageContent } from "@plugins/code-explorer/plugins/code-api/core";

export {
  resolveWorkspaceRoot,
  resolveWorktreePath,
} from "./internal/resolve-worktree-path";
export { getRangeFiles } from "./internal/get-push-files";
export {
  pushRangeReads,
  resolvePushRange,
  type PushRange,
} from "./internal/push-range";

export default {
  description:
    "Worktree-scoped checkout reads by attempt id or the reserved `main` sentinel: the raw image route, the sha-addressed commit-info / commit-files live values, and push-files — one push's files, its range read from its ledger rows by ancestry.",
  contributions: [
    ...commitInfoServed.declare,
    ...commitFilesServed.declare,
    ...pushFilesServed.declare,
  ],
  httpRoutes: {
    [getImageContent.route]: handleImageContent,
  },
} satisfies ServerPluginDefinition;
