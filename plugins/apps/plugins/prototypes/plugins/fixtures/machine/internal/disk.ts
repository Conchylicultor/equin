import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { prototypeFixtureDataOf, type PrototypeFixtureData } from "../../core";

/** The two folders a fixture directory holds. */
const FIXTURE_FOLDERS = ["prototypes", "thumbnails"] as const;

/**
 * A fixture directory off disk — its `prototypes/` tree and its
 * `thumbnails/<fingerprint>.png` — as a writer is handed it (a worker has the
 * same folder inlined in its bundle). Anything else in the directory is not
 * the fixture's, and not read. A directory with no `prototypes/` throws.
 */
export function readPrototypeFixtureDir(dir: string): PrototypeFixtureData {
  if (!existsSync(join(dir, "prototypes")))
    throw new Error(
      `prototype fixture: ${dir} has no prototypes/ folder — a fixture directory holds prototypes/ and thumbnails/`,
    );
  const files: Record<string, Uint8Array> = {};
  for (const folder of FIXTURE_FOLDERS) {
    const root = join(dir, folder);
    if (!existsSync(root)) continue;
    for (const rel of readdirSync(root, { recursive: true }) as string[])
      if (statSync(join(root, rel)).isFile())
        files[`${folder}/${rel.split(sep).join("/")}`] = new Uint8Array(
          readFileSync(join(root, rel)),
        );
  }
  return prototypeFixtureDataOf(files);
}
