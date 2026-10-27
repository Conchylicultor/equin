import { prototypesDir } from "@plugins/apps/plugins/prototypes/data-dirs";
import type { Mount } from "@plugins/infra/plugins/paths/plugins/data-files/core";
import { diskMount } from "@plugins/infra/plugins/paths/plugins/data-files/machine";
import {
  openGitHistoryStore,
  type GitHistoryStore,
} from "../machine/internal/history/store";

// The prototypes tree as a verb sees it: a CLI process boots no plugin graph,
// so it reads the data dir through a disk mount of it — the same operations and
// the same lock files (`_picks/<id>.lock`, `_history/<id>.lock`) the backends'
// `prototypesFiles` root uses, so a verb and a running backend interleave
// safely — and the history through the same git store the desktop provides.

/** The data dir's files. */
export function cliFiles(): Mount {
  return diskMount(prototypesDir);
}

/** The data dir's version history (the desktop's git store). */
export function cliHistory(): GitHistoryStore {
  return openGitHistoryStore({
    dir: () => prototypesDir.path,
    files: cliFiles(),
  });
}
