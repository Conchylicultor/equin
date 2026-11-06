import { ensureDep } from "@plugins/infra/plugins/deps/deps";
import { builtFile } from "@plugins/infra/plugins/deps/plugins/build/deps";
import { cliExecContext } from "@plugins/infra/plugins/jobs/plugins/supervised-job/cli";
import { asAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { copyFile, mkdir, rename } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { parcelWatcherAddon, parcelWatcherPackageDir } from "../../deps";

/**
 * Put the patched `@parcel/watcher` addon where this checkout's patched
 * `index.js` loads it first: ensure the `parcel-watcher-addon` build (cached
 * per machine by identity — a hash and one `ready.json` read when unchanged)
 * and copy it into `node_modules/@parcel/watcher/build/Release/watcher.node`.
 *
 * Run by `./equin build` after its install, every build: an install that
 * re-creates the package (a patch or a version change) drops the copy, and the
 * next build puts the matching one back. A copy rather than a link, so the
 * deps sweep removing an old identity can never leave a checkout loading
 * nothing. Written beside and renamed over, so a backend starting meanwhile
 * loads the old file or the new one, never a torn one.
 *
 * Darwin only: the patch fixes the kqueue backend, which the engine uses
 * there. A failed build throws — it is a compile error to fix, and a build
 * that shipped upstream's addon would leak again without a word.
 */
export async function linkParcelWatcherAddon(opts: {
  root: string;
  log: (line: string) => void;
}): Promise<void> {
  if (process.platform !== "darwin") return;
  const ready = await ensureDep(parcelWatcherAddon, cliExecContext(), {
    root: asAppPath(opts.root),
    log: opts.log,
  });
  const releaseDir = join(
    await parcelWatcherPackageDir(opts.root),
    "build",
    "Release",
  );
  await mkdir(releaseDir, { recursive: true });
  const target = join(releaseDir, "watcher.node");
  const staged = `${target}.${process.pid}.tmp`;
  await copyFile(builtFile(ready), staged, constants.COPYFILE_FICLONE);
  await rename(staged, target);
}
