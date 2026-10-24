import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

// The git reads behind `edited-files`, importable by other servers
// (review/plugin-changes diffs the same file set). The live value itself is
// served by the machine half: it reads the worktree on disk.
export { getEditedFiles } from "./internal/get-edited-files";
export { editedFilesSignature } from "./internal/edited-files-signature";
// The worktree watch behind `edited-files`: notifies when the edited list
// changes. A value that moves with it follows this watch — the paged
// `edited-files` cannot be a `recomputeOn` upstream (a keyed window cascades
// nothing, D32).
export { watchEditedFiles } from "./internal/watch-edited-files";

export default {
  description:
    "Tracks edited files in the conversation's worktree via the live-state primitive: the git reads (getEditedFiles, editedFilesSignature) and the worktree watch (watchEditedFiles) other servers share. The live value is served by the machine half.",
} satisfies ServerPluginDefinition;
