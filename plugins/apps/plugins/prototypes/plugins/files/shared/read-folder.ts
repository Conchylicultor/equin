import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isScannableFile, type PrototypeFolder } from "../core";

// Reading one prototype folder off disk, for the two callers that validate it:
// the server's lister (over `~/.equin/apps/prototypes/`) and the check (over
// the repo's `_template/` seed). Kept out of `core/` because it touches `fs` and
// `core` is what the browser imports.

/**
 * The prototype folders directly under `root`, sorted.
 *
 * `_`-prefixed and dot-dirs are excluded: `_template` is a seed, not a
 * prototype. A missing `root` is a legitimate state (nothing authored yet), not
 * an error.
 */
export async function listPrototypeDirNames(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return entries
    .filter(
      (e) =>
        e.isDirectory() && !e.name.startsWith("_") && !e.name.startsWith("."),
    )
    .map((e) => e.name)
    .sort();
}

/**
 * Read `<root>/<dirName>/` into the shape {@link validatePrototypeFolder} takes:
 * its immediate subdirs and files (dot-entries dropped), plus the text of every
 * scannable file. `siblings` is the set of other prototype names this folder
 * must not reach into.
 */
export async function readPrototypeFolder(
  root: string,
  dirName: string,
  siblings: string[],
): Promise<PrototypeFolder> {
  const dirAbs = join(root, dirName);
  const entries = await readdir(dirAbs, { withFileTypes: true });

  const subdirs: string[] = [];
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) subdirs.push(entry.name);
    else files.push(entry.name);
  }

  const texts = new Map<string, string>();
  for (const fileName of files) {
    if (!isScannableFile(fileName)) continue;
    texts.set(fileName, await readFile(join(dirAbs, fileName), "utf8"));
  }

  return { dirName, subdirs, files, texts, siblings };
}
