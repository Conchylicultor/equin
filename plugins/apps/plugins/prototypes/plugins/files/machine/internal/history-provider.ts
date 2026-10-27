import { prototypesDir } from "@plugins/apps/plugins/prototypes/data-dirs";
import { prototypesFiles } from "@plugins/apps/plugins/prototypes/server";
import { openGitHistoryStore } from "./history/store";

/**
 * The desktop's version history: the git store over the app's data dir, its
 * per-repo lock taken through the `prototypesFiles` root — the same
 * `_history/<id>.lock` the CLI's disk mount takes.
 */
export const gitHistory = openGitHistoryStore({
  dir: () => prototypesDir.path,
  files: prototypesFiles,
});
