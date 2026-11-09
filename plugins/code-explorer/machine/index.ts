import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { codeDirServed } from "./internal/dir-value";
import { codeFileDiffServed, codeFileServed } from "./internal/file-values";
import { commitFilesServed, commitInfoServed } from "./internal/commit-values";
import { workspaceRootServed } from "./internal/workspace-root-value";
import {
  checkoutFileBytesServed,
  checkoutFileTextServed,
  handleCheckoutRaw,
} from "./internal/checkout-file-system";
import { checkoutFileRaw } from "@plugins/infra/plugins/paths/plugins/file-systems/core";

export { watchCheckout } from "./internal/workspace";
export {
  workspaceAttemptIds,
  workspaceRootFrom,
  type WorkspaceRoot,
} from "../server/internal/resolve-worktree-path";

export default {
  description:
    "code-explorer's desktop half: a workspace's files as live values — code.file (a file's text, on disk or at a ref), code.file-diff (one file's diff), code.dir (a folder, key-range-paged by name) and the sha-addressed code.commit-info / code.commit-files, and code.workspace-root (where a workspace id lives on disk) — notified while read from a watch of the file or folder (host-fs) or the checkout watch (HEAD and the refs for a read as of a ref; the index too for a diff), never for a read pinned to shas; a checkout as a file system (file-systems' `checkout` reads: files.checkout.text / .bytes and GET /api/files/checkout/raw — any file, on disk or as of a ref); plus workspaceAttemptIds / workspaceRootFrom, the root a value resolves from the attempt row it follows (tasks-core's attemptWorkspaces), re-pointing its watch when the row moves.",
  httpRoutes: {
    [checkoutFileRaw.route]: handleCheckoutRaw,
  },
  contributions: [
    ...codeFileServed.declare,
    ...codeFileDiffServed.declare,
    ...codeDirServed.declare,
    ...commitInfoServed.declare,
    ...commitFilesServed.declare,
    ...workspaceRootServed.declare,
    ...checkoutFileTextServed.declare,
    ...checkoutFileBytesServed.declare,
  ],
} satisfies MachinePluginDefinition;
