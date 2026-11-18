/**
 * Writes a release's checksum files, in one of the workflow's two phases.
 *
 *   bun plugins/installer/plugins/release-assets/scripts/assemble.ts \
 *     --mode core --tag <tag> --commit <sha> --dir <dir> [--installers]
 *   bun plugins/installer/plugins/release-assets/scripts/assemble.ts \
 *     --mode installer --dir <dir>
 *
 * - `core` (the publish job): `<dir>` holds the tag's install.sh; writes
 *   `release.json` (`installers: 1` with `--installers`: the tag has the
 *   window's crate, its binaries will be attached) and `SHA256SUMS` over
 *   install.sh and release.json. These files are published first and never
 *   change.
 * - `installer` (the attach job): `<dir>` holds the installer binaries that
 *   were built (INSTALLER_BINARIES names); writes `INSTALLER-SHA256SUMS` over
 *   them. Refuses a dir with none.
 *
 * Run by `.github/workflows/installer-release.yml` from the workflow's own
 * checkout (a manual rebuild of an older tag still uses this code); locally,
 * `./equin run` it.
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import {
  existsSync,
  readFileSync,
} from "@plugins/packages/plugins/timed-fs/core";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  INSTALLER_BINARIES,
  type InstallerPlatform,
  RELEASE_FILES,
  releaseManifest,
  sha256Sums,
} from "../core";

const USAGE =
  "usage: assemble.ts --mode core --tag <tag> --commit <sha> --dir <dir> [--installers]\n" +
  "       assemble.ts --mode installer --dir <dir>";

const { values } = parseArgs({
  options: {
    mode: { type: "string" },
    tag: { type: "string" },
    commit: { type: "string" },
    dir: { type: "string" },
    installers: { type: "boolean", default: false },
  },
  strict: true,
});
const { mode, tag, commit, dir, installers } = values;
if (dir === undefined) throw new Error(USAGE);

/** Write `<sumsName>` over `names` in `root`, and print it. */
function writeSums(
  root: string,
  names: readonly string[],
  sumsName: string,
): void {
  const sums = sha256Sums(
    names.map((name) => ({
      name,
      sha256: createHash("sha256")
        .update(readFileSync(join(root, name)))
        .digest("hex"),
    })),
  );
  writeFileSync(join(root, sumsName), sums);
  process.stdout.write(`${sumsName}:\n${sums}`);
}

if (mode === "core") {
  if (tag === undefined || commit === undefined) throw new Error(USAGE);
  const script = readFileSync(join(dir, RELEASE_FILES.script), "utf8");
  const manifest = releaseManifest({ tag, commit, script, installers });
  writeFileSync(
    join(dir, RELEASE_FILES.manifest),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  console.log(JSON.stringify(manifest, null, 2));
  writeSums(
    dir,
    [RELEASE_FILES.script, RELEASE_FILES.manifest],
    RELEASE_FILES.sums,
  );
} else if (mode === "installer") {
  if (tag !== undefined || commit !== undefined || installers)
    throw new Error(USAGE);
  const built = (Object.keys(INSTALLER_BINARIES) as InstallerPlatform[])
    .map((p) => INSTALLER_BINARIES[p])
    .filter((name) => existsSync(join(dir, name)));
  if (built.length === 0)
    throw new Error(`no installer binary in ${dir}: nothing to attach`);
  writeSums(dir, built, RELEASE_FILES.installerSums);
} else {
  throw new Error(USAGE);
}
