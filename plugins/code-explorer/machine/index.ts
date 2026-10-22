import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { codeDirServed } from "./internal/dir-value";
import { codeFileDiffServed, codeFileServed } from "./internal/file-values";
import { commitFilesServed, commitInfoServed } from "./internal/commit-values";
import { handleImage } from "./internal/image-route";
import { getImageContent } from "@plugins/code-explorer/plugins/code-api/core";

export { watchWorkspaceFile } from "./internal/file-values";
export {
  readWorkspaceBytes,
  workspaceFileSignature,
} from "./internal/workspace-bytes";
export {
  loadWorkspaceRoot,
  watchCheckout,
  watchWorkspaceRoot,
  workspaceRootReads,
  type WorkspaceFile,
} from "./internal/workspace";

export default {
  description:
    "code-explorer's desktop half: a workspace's files as live values — code.file (a file's text, on disk or at a ref), code.file-diff (one file's diff), code.dir (a folder, key-range-paged by name) and the sha-addressed code.commit-info / code.commit-files — notified while read from a watch of the file or folder (host-fs) or the checkout watch (HEAD and the refs for a read as of a ref; the index too for a diff), never for a read pinned to shas; plus readWorkspaceBytes / workspaceFileSignature / watchWorkspaceFile, the workspace half of file-viewer.bytes, and loadWorkspaceRoot / watchWorkspaceRoot, the root resolve its loaders and watches share. And the raw image route (GET /api/code/:worktree/image, needsMachine): a checkout image's bytes.",
  httpRoutes: {
    [getImageContent.route]: handleImage,
  },
  contributions: [
    ...codeFileServed.declare,
    ...codeFileDiffServed.declare,
    ...codeDirServed.declare,
    ...commitInfoServed.declare,
    ...commitFilesServed.declare,
  ],
} satisfies MachinePluginDefinition;
