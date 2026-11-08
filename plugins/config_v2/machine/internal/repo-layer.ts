import { readdir, readFile } from "@plugins/packages/plugins/timed-fs/core";
import { join, sep } from "node:path";
import {
  APP_SCOPE_DIR,
  appScopeId,
  committedDocument,
  committedFilesFromMap,
  configFileRelPath,
  storePathParts,
} from "../../core";
import type { ConfigFileRef, ConfigGitLayerImpl } from "../../core";
import { repoConfigDir } from "@plugins/infra/plugins/paths/server";
import { acquireDirWatch } from "@plugins/infra/plugins/file-watcher/server";

/** One committed file's text, or null when the checkout has none. */
async function readOrNull(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw err;
  }
}

/**
 * The committed files ONE descriptor's document is resolved from — its origin,
 * its override and each `@app/<id>` override under its hierarchy dir — read
 * off the checkout's `config/` (or a release's, `EQUIN_REPO_CONFIG_DIR`)
 * without holding the thread, keyed by their layer-relative path.
 */
async function committedFilesOf(
  storePath: string,
): Promise<Map<string, string>> {
  const dir = repoConfigDir();
  const { hier } = storePathParts(storePath);
  const appDir = join(dir, hier, APP_SCOPE_DIR);
  let appIds: string[];
  try {
    appIds = (await readdir(appDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
    appIds = [];
  }
  const refs: ConfigFileRef[] = [
    { storePath, file: "origin" },
    { storePath, file: "override" },
    ...appIds.map((appId): ConfigFileRef => ({
      storePath,
      scopeId: appScopeId(appId),
      file: "override",
    })),
  ];
  const files = new Map<string, string>();
  await Promise.all(
    refs.map(async (ref) => {
      const rel = configFileRelPath(ref);
      const text = await readOrNull(join(dir, rel));
      if (text !== null) files.set(rel, text);
    }),
  );
  return files;
}

/**
 * The desktop's committed layer: the checkout's `config/`, read per call (its
 * callers are scope removal and the git-defaults preview's loader) — through
 * `committedDocument`, the rule every reader of a committed layer resolves
 * with. A committed `@app/<id>` delta resolves over its base origin, so a delta
 * whose base has neither an origin nor an override reads as no document — the
 * build always generates the origin, so a checkout never holds one.
 */
export const repoConfigLayer: ConfigGitLayerImpl = {
  async document(storePath) {
    const files = committedFilesFromMap(await committedFilesOf(storePath));
    return committedDocument(storePath, files);
  },
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
