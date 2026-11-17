/**
 * The release job's last step before publishing: writes `release.json` and
 * `SHA256SUMS` beside the assets the build jobs produced.
 *
 *   bun plugins/installer/plugins/release-assets/scripts/assemble.ts \
 *     --tag <tag> --commit <sha> --dir <assets dir>
 *
 * `<assets dir>` holds the tag's install.sh and whichever installer binaries
 * were built (INSTALLER_BINARIES names; none for a tag cut before the window
 * existed). Run by `.github/workflows/installer-release.yml` from the
 * workflow's own checkout (a manual rebuild of an older tag still uses this
 * code); locally, `./equin run` it.
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

const { values } = parseArgs({
  options: {
    tag: { type: "string" },
    commit: { type: "string" },
    dir: { type: "string" },
  },
  strict: true,
});
const { tag, commit, dir } = values;
if (tag === undefined || commit === undefined || dir === undefined)
  throw new Error("usage: assemble.ts --tag <tag> --commit <sha> --dir <dir>");

const script = readFileSync(join(dir, RELEASE_FILES.script), "utf8");
const built = (Object.keys(INSTALLER_BINARIES) as InstallerPlatform[]).filter(
  (p) => existsSync(join(dir, INSTALLER_BINARIES[p])),
);
const manifest = releaseManifest({ tag, commit, script, built });
writeFileSync(
  join(dir, RELEASE_FILES.manifest),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

const names = [
  RELEASE_FILES.script,
  RELEASE_FILES.manifest,
  ...built.map((p) => INSTALLER_BINARIES[p]),
];
const sums = sha256Sums(
  names.map((name) => ({
    name,
    sha256: createHash("sha256")
      .update(readFileSync(join(dir, name)))
      .digest("hex"),
  })),
);
writeFileSync(join(dir, RELEASE_FILES.sums), sums);
console.log(JSON.stringify(manifest, null, 2));
process.stdout.write(sums);
