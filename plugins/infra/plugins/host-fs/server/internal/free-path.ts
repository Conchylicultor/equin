import { lstat } from "node:fs/promises";
import { extname, join } from "node:path";
import { classifyFsError } from "./path";

/** Whether anything (a dangling symlink included) sits at `path`. */
export async function isTaken(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (err) {
    if (classifyFsError(err) === "missing") return false;
    throw err;
  }
}

/**
 * `name` in `dir`, or — when that is taken — the Finder's next free spelling:
 * `photos 2`, `photos 3`, … for a folder, `a 2.txt` for a file.
 */
export async function freePath(
  dir: string,
  name: string,
  isFile: boolean,
): Promise<string> {
  const ext = isFile ? extname(name) : "";
  const stem = name.slice(0, name.length - ext.length);
  let candidate = join(dir, name);
  for (let n = 2; await isTaken(candidate); n++) {
    candidate = join(dir, `${stem} ${n}${ext}`);
  }
  return candidate;
}
