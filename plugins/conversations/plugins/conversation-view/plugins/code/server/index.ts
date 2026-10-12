import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { editedFilesServed } from "./internal/edited-files-resource";

export { getEditedFiles } from "./internal/get-edited-files";
export { editedFilesServed } from "./internal/edited-files-resource";
export { editedFilesSignature } from "./internal/edited-files-signature";

export default {
  description:
    "Tracks edited files in the conversation's worktree via the live-state primitive.",
  contributions: [...editedFilesServed.declare],
} satisfies ServerPluginDefinition;
