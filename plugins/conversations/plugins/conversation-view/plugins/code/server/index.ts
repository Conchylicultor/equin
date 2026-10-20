import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

// The git reads behind `edited-files`, importable by other servers
// (review/plugin-changes diffs the same file set). The live value itself is
// served by the machine half: it reads the worktree on disk.
export { getEditedFiles } from "./internal/get-edited-files";
export { editedFilesSignature } from "./internal/edited-files-signature";

export default {
  description:
    "Tracks edited files in the conversation's worktree via the live-state primitive: the git reads (getEditedFiles, editedFilesSignature) other servers share. The live value is served by the machine half.",
} satisfies ServerPluginDefinition;
