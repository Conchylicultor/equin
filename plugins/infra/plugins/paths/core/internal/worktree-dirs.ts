import { readdirSync, statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { worktreesDir } from "./paths";

// Enumerate the real worktree directory names under `worktreesDir()`. The dir
// also holds non-directory entries (att-*.json sidecars, Finder .DS_Store) —
// only directories have logs/, so anything else is skipped. A missing
// worktrees dir means "no worktrees yet" and yields [].
export function listWorktreeDirs(): string[] {
  return listDirNames(worktreesDir());
}

// Parameterized on dir only so the co-located test can run against a temp dir.
export function listDirNames(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const dirs: string[] = [];
  for (const name of names) {
    let isDir = false;
    try {
      isDir = statSync(join(dir, name)).isDirectory();
    } catch (err) {
      // A worktree dir can vanish mid-scan (concurrent reap); treat as absent.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (isDir) dirs.push(name);
  }
  return dirs;
}

// `listWorktreeDirs` without blocking the event loop — for a caller on a hot
// async path (a live-resource loader), where ~200 sync stats would freeze every
// other loader and request for the scan's whole duration.
export async function listWorktreeDirsAsync(): Promise<string[]> {
  return listDirNamesAsync(worktreesDir());
}

export async function listDirNamesAsync(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const flags = await Promise.all(
    names.map(async (name) => {
      try {
        return (await stat(join(dir, name))).isDirectory();
      } catch (err) {
        // A worktree dir can vanish mid-scan (concurrent reap); treat as absent.
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        return false;
      }
    }),
  );
  return names.filter((_, i) => flags[i]);
}
