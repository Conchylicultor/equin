import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { commitFilesServed, commitInfoServed } from "./internal/commit-values";
import { handleFileContent } from "./internal/file-content-handler";
import { handleFileDiff } from "./internal/file-diff-handler";
import { handleImageContent } from "./internal/image-handler";
import { handleListDir } from "./internal/list-dir-handler";
import { handlePushFiles } from "./internal/push-handler";
import {
  getFileContent,
  getFileDiff,
  getImageContent,
  getPushFiles,
  listCodeDir,
} from "@plugins/code-explorer/plugins/code-api/core";

export { resolveWorktreePath } from "./internal/resolve-worktree-path";
export { resolveParentSha, getRangeFiles } from "./internal/get-push-files";

export default {
  description:
    "Worktree-scoped file reads: raw/diff/image content and directory listings by attempt id or the reserved `main` sentinel.",
  contributions: [...commitInfoServed.declare, ...commitFilesServed.declare],
  httpRoutes: {
    [getFileContent.route]: handleFileContent,
    [getFileDiff.route]: handleFileDiff,
    [getImageContent.route]: handleImageContent,
    [getPushFiles.route]: handlePushFiles,
    [listCodeDir.route]: handleListDir,
  },
} satisfies ServerPluginDefinition;
