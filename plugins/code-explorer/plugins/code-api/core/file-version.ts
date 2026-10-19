import { liveValue } from "@plugins/network/plugins/live/core";
import { FileVersionSchema } from "@plugins/infra/plugins/host-fs/core";

/**
 * The on-disk revision of `path` (relative) in the workspace `worktree` names
 * — the same addressing as the `file` route's read without a `ref`: an attempt
 * id of any workspace kind, `"main"`, `"self"`, or a checkout's absolute root.
 * Pushed while subscribed from a watch of the file's folder, so a reader holds
 * it beside its own content read and re-reads when the stamp moves. A read as
 * of a ref has no revision to follow.
 *
 * - `no-workspace` — `worktree` names no workspace.
 * - `invalid-path` — `path` is not a path inside it.
 */
export const codeFileVersion = liveValue("code.file-version", {
  schema: FileVersionSchema,
  params: ["worktree", "path"],
  refusals: ["no-workspace", "invalid-path"],
  needsMachine: { feature: "Watching checkout files" },
});
