import { defineAppDataDir } from "@plugins/infra/plugins/paths/core";
import { fileExplorerApp } from "@plugins/apps/plugins/file-explorer/plugins/shell/core";

/**
 * Files' one data dir, `apps/file-explorer`: the user's Documents — files
 * kept by equin itself rather than somewhere on the computer's disk, so they
 * exist on every host (memory, kept in the browser's storage, in a browser
 * host). The `documents` sub-plugin's file root is the only door to it.
 *
 * Host-global and not in git, like every app dir: its only copy is what the
 * user put there, which is why an app dir is never reclaimable.
 */
export const fileExplorerDir = defineAppDataDir(fileExplorerApp, {
  owner: "apps/file-explorer",
  description:
    "The user's Documents in Files: files equin keeps itself, on every host",
});

export default [fileExplorerDir];
