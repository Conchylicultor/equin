import { lstat, readdir, readlink, statfs } from "node:fs/promises";
import { join } from "node:path";
import type { HostFsVolumeResult } from "../../core";
import { classifyFsError } from "./path";

const VOLUMES_DIR = "/Volumes";

/**
 * The display name of the volume holding `path`. macOS mounts every volume
 * but the boot one at `/Volumes/<name>`; the boot volume (where `/`, and
 * through its firmlinks `/Users`, live) appears there as a symlink to `/`,
 * whose name is the one the Finder shows ("Macintosh HD"). Off macOS, or with
 * no such link, the boot volume is named `/`.
 */
async function volumeName(path: string): Promise<string> {
  const under = path.startsWith(`${VOLUMES_DIR}/`)
    ? path.slice(VOLUMES_DIR.length + 1)
    : "";
  if (under !== "") return under.split("/")[0]!;
  return (await bootVolumeName()) ?? "/";
}

async function bootVolumeName(): Promise<string | undefined> {
  let names: string[];
  try {
    names = await readdir(VOLUMES_DIR);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined; // not macOS
    throw err;
  }
  for (const name of names) {
    const entry = join(VOLUMES_DIR, name);
    if (
      (await lstat(entry)).isSymbolicLink() &&
      (await readlink(entry)) === "/"
    )
      return name;
  }
  return undefined;
}

/** The storage of the volume holding the absolute path `path`. */
export async function hostVolume(path: string): Promise<HostFsVolumeResult> {
  try {
    const fs = await statfs(path);
    return {
      kind: "ok",
      path,
      name: await volumeName(path),
      total: fs.blocks * fs.bsize,
      free: fs.bavail * fs.bsize,
    };
  } catch (err) {
    return { kind: classifyFsError(err), path };
  }
}
