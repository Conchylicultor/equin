import {
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  exists,
  readdir,
  readFile,
  stat,
} from "@plugins/packages/plugins/timed-fs/core";
import { PLUGINS_DIR } from "@plugins/infra/plugins/paths/core";
import { prototypesDir } from "@plugins/apps/plugins/prototypes/data-dirs";
import { parsePrototypeTree } from "@plugins/apps/plugins/prototypes/plugins/fixtures/core";
import { readPrototypeFixtureDir } from "@plugins/apps/plugins/prototypes/plugins/fixtures/machine";
import { writePrototypeFixture } from "@plugins/apps/plugins/prototypes/plugins/fixtures/server";

/** The committed fixture: the Circle prototype the film's Create beat shows, with its history. */
const FIXTURE_DIR = joinAppPath(
  PLUGINS_DIR,
  "apps/plugins/website/plugins/promo-film/plugins/seed/data",
);

/**
 * Make sure the film's prototype is in the Prototypes app. Prototype files are
 * host-global (one folder shared by main and every worktree), so the seed
 * never overwrites one: a folder that is absent is written from the committed
 * fixture through the app's writer (adopted into its history by the files
 * watcher); a folder that is present must hold exactly the fixture's newest
 * version, or the seed refuses — the film would otherwise show a prototype the
 * repo does not describe.
 */
export async function ensureFilmPrototype(): Promise<string> {
  const data = await readPrototypeFixtureDir(FIXTURE_DIR);
  const parsed = parsePrototypeTree(data.tree);
  const absent: string[] = [];
  for (const proto of parsed.prototypes) {
    const newest = proto.versions[proto.versions.length - 1]!;
    const folder = prototypesDir.file(proto.id);
    if (!(await exists(folder))) {
      absent.push(proto.id);
      continue;
    }
    const onDisk = await readFolder(folder);
    const want = Object.keys(newest.files).sort();
    const have = Object.keys(onDisk).sort();
    const differs =
      want.join("\n") !== have.join("\n") ||
      want.some((name) => onDisk[name] !== newest.files[name]);
    if (differs)
      throw new Error(
        `[promo-film seed] the prototype ${proto.id} on disk (${folder}) is not the committed fixture's v${newest.n} (files ${have.join(", ")} vs ${want.join(", ")}). Prototype folders are shared with main, so the seed never overwrites one: update the fixture in ${FIXTURE_DIR} from the folder (and re-render its thumbnails), or restore the folder.`,
      );
  }
  if (absent.length === 0) return "already present, identical to the fixture";
  if (absent.length !== parsed.prototypes.length)
    throw new Error(
      `[promo-film seed] only some of the fixture's prototypes are on disk (missing: ${absent.join(", ")}); the writer writes a fixture whole, so restore the others or split the fixture.`,
    );
  await writePrototypeFixture(data);
  return `written from the fixture: ${absent.join(", ")}`;
}

/** A prototype folder's files (flat, text), as the fixture describes one. */
async function readFolder(dir: AppPath): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const name of await readdir(dir))
    if ((await stat(joinAppPath(dir, name))).isFile())
      files[name] = await readFile(joinAppPath(dir, name), "utf8");
  return files;
}
