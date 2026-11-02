import { existsSync, mkdirSync, readdirSync, copyFileSync } from "node:fs";
import {
  type AppPath,
  joinAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { assetMirrorRelativeToRoot } from "../../data-dirs";

/** The bundle subdir this primitive owns, and the name the release pipeline
 *  bakes assets under. Kept here so the launcher never has to know the literal
 *  name. The DESTINATION under the app-data root is NOT this — it comes from the
 *  cache's own declaration (see `assetMirrorRelativeToRoot`), so the two cannot
 *  drift when the declared directory moves. */
const ASSET_MIRROR_BUNDLE_SUBDIR = "asset-mirror";

/**
 * Seed the app-data asset-mirror cache from a release bundle on first run.
 *
 * Recursively copies every file under `<bundleRoot>/asset-mirror` into the
 * asset-mirror cache's declared spot beneath `<dataDir>`, creating parent dirs as
 * needed. `dataDir` is a parameter rather than this process's own data root
 * because the target may be a fresh install's — a preview root under `/tmp`, or
 * a release's bundled data dir — which is why the destination is composed from a
 * root plus the cache's declared relative location. COPY-IF-ABSENT: any
 * file that already exists at the destination is skipped, so a user's
 * previously-downloaded samples are never clobbered and newly-shipped files are
 * filled in. No-op if `<bundleRoot>/asset-mirror` does not exist (e.g. a release
 * whose closure had no prewarm contributors).
 *
 * Synchronous on purpose — it runs once at launch, before the backend starts
 * serving mirror requests.
 */
export function seedAssetMirrorCache(opts: {
  bundleRoot: AppPath;
  dataDir: AppPath;
  log?: (m: string) => void;
}): void {
  const { bundleRoot, dataDir } = opts;
  const log = opts.log ?? (() => {});

  const src = joinAppPath(bundleRoot, ASSET_MIRROR_BUNDLE_SUBDIR);
  if (!existsSync(src)) return;

  const dest = joinAppPath(dataDir, assetMirrorRelativeToRoot());
  let copied = 0;

  const walk = (from: AppPath, to: AppPath): void => {
    mkdirSync(to, { recursive: true });
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      const fromPath = joinAppPath(from, entry.name);
      const toPath = joinAppPath(to, entry.name);
      if (entry.isDirectory()) {
        walk(fromPath, toPath);
      } else if (entry.isFile() && !existsSync(toPath)) {
        copyFileSync(fromPath, toPath);
        copied++;
      }
    }
  };

  walk(src, dest);
  if (copied > 0) {
    log(`[asset-mirror] seeded ${copied} file(s) into ${dest}`);
  }
}
