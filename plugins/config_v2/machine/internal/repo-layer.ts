import {
  existsSync,
  readdirSync,
  readFileSync,
} from "@plugins/packages/plugins/timed-fs/core";
import { join, sep } from "node:path";
import {
  committedDocument,
  committedFilesIn,
  OWNER_CONFIG_DIR,
  storePathParts,
  withOwnerLayer,
} from "../../core";
import type { CommittedFiles, ConfigGitLayerImpl } from "../../core";
import {
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { repoConfigDir } from "@plugins/infra/plugins/paths/server";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { acquireDirWatch } from "@plugins/infra/plugins/file-watcher/server";

const fs = { existsSync, readFileSync, readdirSync };

/**
 * The checkout's committed layer: `config/` (or a release's vendored tree,
 * `EQUIN_REPO_CONFIG_DIR`) with the owner's `owner-config/` on top. A release
 * vendors `config/` alone, so its owner root names nothing and reads as empty.
 */
function checkoutFiles(): CommittedFiles {
  return withOwnerLayer(
    committedFilesIn(repoConfigDir(), fs),
    committedFilesIn(ownerConfigDir(), fs),
  );
}

/** The owner's committed root (`owner-config/`), present or not. */
export function ownerConfigDir(): AppPath {
  return joinAppPath(REPO_ROOT, OWNER_CONFIG_DIR);
}

/** The committed roots this checkout has, to watch: `config/`, and `owner-config/` when it exists. */
export function committedRoots(): AppPath[] {
  return [repoConfigDir(), ownerConfigDir()].filter((dir) => existsSync(dir));
}

/**
 * The desktop's committed layer: the checkout's `config/` under `owner-config/`
 * ({@link checkoutFiles}), read per call (the only caller is scope removal). A committed `@app/<id>` delta resolves over its
 * base origin, so a delta whose base has neither an origin nor an override reads
 * as no document — the build always generates the origin, so a checkout never
 * holds one.
 */
export const repoConfigLayer: ConfigGitLayerImpl = {
  document: (storePath) => committedDocument(storePath, checkoutFiles()),
  // The descriptor's committed files all sit under its hierarchy dir (origin,
  // override, `@app/<id>` deltas) in either root; a child plugin's files under it
  // only cost a spurious re-read. A checkout without an owner layer watches
  // `config/` alone (a root created later is read, not heard, until a restart).
  async watch(storePath, onChange) {
    const { hier } = storePathParts(storePath);
    const roots = committedRoots();
    const hierDirs = roots.map((dir) => join(dir, hier) + sep);
    const stops = await Promise.all(
      roots.map((dir) =>
        acquireDirWatch({
          dir,
          scope: "subtree",
          onChange: (events) => {
            if (events.some((e) => hierDirs.some((d) => e.path.startsWith(d))))
              onChange();
          },
        }),
      ),
    );
    return () => {
      for (const stop of stops) stop();
    };
  },
};
