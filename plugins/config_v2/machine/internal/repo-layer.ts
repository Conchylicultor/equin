import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  APP_SCOPE_DIR,
  committedDocument,
  configFileRelPath,
  storePathParts,
} from "../../core";
import type { CommittedFiles, ConfigGitLayerImpl } from "../../core";
import { repoConfigDir } from "@plugins/infra/plugins/paths/server";

/** The checkout's `config/` (or a release's, `SINGULARITY_REPO_CONFIG_DIR`) as raw files. */
function fsCommittedFiles(dir: string): CommittedFiles {
  return {
    read(ref) {
      const file = join(dir, configFileRelPath(ref));
      return existsSync(file) ? readFileSync(file, "utf-8") : null;
    },
    appIds(storePath) {
      const appDir = join(dir, storePathParts(storePath).hier, APP_SCOPE_DIR);
      if (!existsSync(appDir)) return [];
      return readdirSync(appDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
    },
  };
}

/**
 * The desktop's committed layer: the checkout's `config/`, read per call (the
 * only caller is scope removal). A committed `@app/<id>` delta resolves over its
 * base origin, so a delta whose base has neither an origin nor an override reads
 * as no document — the build always generates the origin, so a checkout never
 * holds one.
 */
export const repoConfigLayer: ConfigGitLayerImpl = {
  document: (storePath) =>
    committedDocument(storePath, fsCommittedFiles(repoConfigDir())),
};
