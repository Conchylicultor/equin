import {
  readText,
  relPath,
  type Mount,
} from "@plugins/infra/plugins/paths/plugins/data-files/core";
import { isScannableFile, type PrototypeFolder } from "../core";

// Reading one prototype folder, for the two callers that validate it: the
// lister (over the `prototypesFiles` root, or the CLI's disk mount of the same
// data dir) and the check (over the repo's `prototypes/`, holding the
// `_template/` seed). Over a `Mount`, so it runs on every host.

/**
 * The prototype folders directly under the mount's root, sorted.
 *
 * `_`-prefixed and dot-dirs are excluded: `_template` is a seed, not a
 * prototype. A missing root is a legitimate state (nothing authored yet), not
 * an error.
 */
export async function listPrototypeDirNames(mount: Mount): Promise<string[]> {
  const listed = await mount.list(relPath());
  if (listed.kind === "missing") return [];
  return listed.entries
    .filter(
      (e) =>
        e.kind === "dir" && !e.name.startsWith("_") && !e.name.startsWith("."),
    )
    .map((e) => e.name)
    .sort();
}

/**
 * Read `<dirName>/` into the shape {@link validatePrototypeFolder} takes: its
 * immediate subdirs and files (dot-entries dropped), plus the text of every
 * scannable file. `siblings` is the set of other prototype names this folder
 * must not reach into. A folder that is not there (removed mid-read) throws.
 */
export async function readPrototypeFolder(
  mount: Mount,
  dirName: string,
  siblings: string[],
): Promise<PrototypeFolder> {
  const dir = relPath(dirName);
  const listed = await mount.list(dir);
  if (listed.kind === "missing") {
    throw new Error(`prototype folder "${dirName}" is not there`);
  }

  const subdirs: string[] = [];
  const files: string[] = [];
  for (const entry of listed.entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.kind === "dir") subdirs.push(entry.name);
    else files.push(entry.name);
  }

  const texts = new Map<string, string>();
  for (const fileName of files) {
    if (!isScannableFile(fileName)) continue;
    const read = await readText(mount, relPath(dirName, fileName));
    if (read.kind === "missing") {
      throw new Error(
        `prototype file "${dirName}/${fileName}" vanished while it was read`,
      );
    }
    texts.set(fileName, read.text);
  }

  return { dirName, subdirs, files, texts, siblings };
}
