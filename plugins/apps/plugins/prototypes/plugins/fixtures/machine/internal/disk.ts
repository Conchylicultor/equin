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
import { sep } from "node:path";
import { prototypeFixtureDataOf, type PrototypeFixtureData } from "../../core";

/** The two folders a fixture directory holds. */
const FIXTURE_FOLDERS = ["prototypes", "thumbnails"] as const;

/**
 * A fixture directory off disk — its `prototypes/` tree and its
 * `thumbnails/<fingerprint>.png` — as a writer is handed it (a worker has the
 * same folder inlined in its bundle). Anything else in the directory is not
 * the fixture's, and not read. A directory with no `prototypes/` throws.
 */
export async function readPrototypeFixtureDir(
  dir: AppPath,
): Promise<PrototypeFixtureData> {
  if (!(await exists(joinAppPath(dir, "prototypes"))))
    throw new Error(
      `prototype fixture: ${dir} has no prototypes/ folder — a fixture directory holds prototypes/ and thumbnails/`,
    );
  const files: Record<string, Uint8Array> = {};
  for (const folder of FIXTURE_FOLDERS) {
    const root = joinAppPath(dir, folder);
    if (!(await exists(root))) continue;
    for (const rel of await readdir(root, { recursive: true }))
      if ((await stat(joinAppPath(root, rel))).isFile())
        files[`${folder}/${rel.split(sep).join("/")}`] = new Uint8Array(
          await readFile(joinAppPath(root, rel)),
        );
  }
  return prototypeFixtureDataOf(files);
}
