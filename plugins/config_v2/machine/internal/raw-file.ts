import {
  existsSync,
  readFileSync,
} from "@plugins/packages/plugins/timed-fs/core";
import { relative } from "node:path";
import { configFileRelPath, configRawFile } from "../../core";
import { serveValue } from "@plugins/network/plugins/live/machine";
import { acquireDirWatch } from "@plugins/infra/plugins/file-watcher/server";
import { repoConfigDir } from "@plugins/infra/plugins/paths/server";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import {
  configRegistryReady,
  configWatcherArmed,
  getDescriptorByStorePath,
  hasConfigDocument,
  onDocumentChange,
} from "@plugins/config_v2/server";
import {
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { CONFIG_DIR } from "./config-dir";
import { userFilePath } from "./file-store";
import { committedRoots, ownerConfigDir } from "./repo-layer";

// The git-layer files of one document. Git-layer files live in the repo, not
// the per-worktree user dir. A scoped override is expressed in git at
// config/<dir>/@app/<id>/<name>.jsonc, but its origin anchor is always the BASE
// origin (config/<dir>/<name>.origin.jsonc) — no scoped origin is ever
// committed. So the override path takes the scope segment while the origin path
// stays base. The override shown is the one that applies: the owner's
// (`owner-config/`) when it commits one, else the shipping layer's.
function gitLayerPaths(
  storePath: string,
  scopeId: string | undefined,
): { gitOverridePath: AppPath; gitOriginPath: AppPath } {
  const overrideRel = configFileRelPath({
    storePath,
    scopeId,
    file: "override",
  });
  const ownerOverride = joinAppPath(ownerConfigDir(), overrideRel);
  return {
    gitOverridePath: existsSync(ownerOverride)
      ? ownerOverride
      : joinAppPath(repoConfigDir(), overrideRel),
    gitOriginPath: joinAppPath(
      repoConfigDir(),
      configFileRelPath({ storePath, file: "origin" }),
    ),
  };
}

function readRaw(path: AppPath): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return null;
  }
}

/**
 * Watch the git layer of one document for as long as its raw text is read: the
 * repo's config tree, filtered to the document's two git files. Nothing else
 * signals them — a build propagates them into the user layer (which the
 * registry's document fan-out covers), but the raw view shows them before that
 * build.
 */
async function watchGitLayer(
  storePath: string,
  scopeId: string | undefined,
  notify: () => void,
): Promise<() => void> {
  // Every path the document's git files can sit at, in either root: the
  // override may move between them (an owner override added or removed).
  const overrideRel = configFileRelPath({
    storePath,
    scopeId,
    file: "override",
  });
  const watched = new Set<string>([
    joinAppPath(repoConfigDir(), overrideRel),
    joinAppPath(ownerConfigDir(), overrideRel),
    gitLayerPaths(storePath, scopeId).gitOriginPath,
  ]);
  const releases = await Promise.all(
    committedRoots().map((dir) =>
      acquireDirWatch({
        dir,
        scope: "subtree",
        onChange: (events) => {
          if (events.some((e) => watched.has(e.path))) notify();
        },
      }),
    ),
  );
  const release = (): void => {
    for (const r of releases) r();
  };
  // A write between the first load and either watch opening (this git-layer
  // one, or the user-layer config-files watcher armed in `onReady`) produced
  // no event; one re-read once both are live closes that gap.
  try {
    await configWatcherArmed();
  } catch (err) {
    release();
    throw err;
  }
  notify();
  return release;
}

/**
 * The raw text of one document's four layered files (`config-v2.raw-file`) —
 * the desktop's files, so a host without the computer has none to show
 * (`needsMachine`).
 *
 * `notified`, from both halves of its truth: the user-layer override and origin
 * are the registry's own document, so its one fan-out (`onDocumentChange`, run
 * on every watcher event and every in-process write) moves this value with the
 * document, its conflicts and its tiers; the git layer is watched while
 * subscribed (`watchGitLayer`).
 *
 * Paths are returned relative to their layer root (user config dir / repo root)
 * so the UI can label each section with a compact, non-wrapping location rather
 * than a noisy absolute path. The label already names the layer.
 */
export const configRawFileServed = serveValue(configRawFile, {
  source: "external",
  changes: "notified",
  loader: async ({ path, scopeId }) => {
    await configRegistryReady();
    if (!getDescriptorByStorePath(path)) {
      throw configRawFile.refuse("missing", `No descriptor for "${path}"`);
    }
    if (!hasConfigDocument(path, scopeId)) {
      throw configRawFile.refuse(
        "missing",
        `No config document for "${path}"${scopeId ? ` in scope "${scopeId}"` : ""}`,
      );
    }
    const override = userFilePath({
      storePath: path,
      scopeId,
      file: "override",
    });
    const origin = userFilePath({ storePath: path, scopeId, file: "origin" });
    const { gitOverridePath, gitOriginPath } = gitLayerPaths(path, scopeId);
    return {
      override: readRaw(override),
      overridePath: relative(CONFIG_DIR, override),
      origin: readRaw(origin),
      originPath: relative(CONFIG_DIR, origin),
      gitOverride: readRaw(gitOverridePath),
      gitOverridePath: relative(REPO_ROOT, gitOverridePath),
      gitOrigin: readRaw(gitOriginPath),
      gitOriginPath: relative(REPO_ROOT, gitOriginPath),
    };
  },
  whileSubscribed: async ({ path, scopeId }, notify) => {
    const off = onDocumentChange((doc) => {
      if (doc.path === path && (doc.scopeId ?? "") === (scopeId ?? ""))
        notify();
    });
    try {
      const release = await watchGitLayer(path, scopeId, notify);
      return () => {
        off();
        release();
      };
    } catch (err) {
      off();
      throw err;
    }
  },
});
