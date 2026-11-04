import {
  existsSync,
  readdirSync,
  readFileSync,
} from "@plugins/packages/plugins/timed-fs/core";
import { join, sep } from "node:path";
import {
  committedDocument,
  committedFilesIn,
  storePathParts,
} from "../../core";
import type { CommittedFiles, ConfigGitLayerImpl } from "../../core";
import { repoConfigDir } from "@plugins/infra/plugins/paths/server";
import { acquireDirWatch } from "@plugins/infra/plugins/file-watcher/server";

/** The checkout's `config/` (or a release's, `EQUIN_REPO_CONFIG_DIR`) as raw files. */
function checkoutFiles(): CommittedFiles {
  return committedFilesIn(repoConfigDir(), {
    existsSync,
    readFileSync,
    readdirSync,
  });
}

/**
 * The desktop's committed layer: the checkout's `config/`, read per call (the
 * only caller is scope removal). A committed `@app/<id>` delta resolves over its
 * base origin, so a delta whose base has neither an origin nor an override reads
 * as no document — the build always generates the origin, so a checkout never
 * holds one.
 */
export const repoConfigLayer: ConfigGitLayerImpl = {
  document: (storePath) => committedDocument(storePath, checkoutFiles()),
  // The descriptor's committed files all sit under its hierarchy dir (origin,
  // override, `@app/<id>` deltas); a child plugin's files under it only cost a
  // spurious re-read.
  async watch(storePath, onChange) {
    const hierDir = join(repoConfigDir(), storePathParts(storePath).hier) + sep;
    return acquireDirWatch({
      dir: repoConfigDir(),
      scope: "subtree",
      onChange: (events) => {
        if (events.some((e) => e.path.startsWith(hierDir))) onChange();
      },
    });
  },
};
