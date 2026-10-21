import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { Dirent } from "node:fs";
import type { CodeDirEntry } from "@plugins/code-explorer/plugins/code-api/core";
import { GIT } from "@plugins/infra/plugins/paths/server";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";

// A local metadata read serving an open read; only a wedged child reaches
// this, and it then fails as a named error (see get-file-content.ts).
const GIT_TIMEOUT_MS = 30_000;

/** One folder's entries, or `missing` when it does not exist (or is not one). */
export type ListResult =
  { kind: "ok"; entries: CodeDirEntry[] } | { kind: "missing" };

/** One folder's entries as they are on disk now (unsorted). */
export async function listOnDisk(absDir: string): Promise<ListResult> {
  let dirents: Dirent[];
  try {
    dirents = await readdir(absDir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "missing" };
    throw err;
  }
  return {
    kind: "ok",
    entries: dirents.map((d) => ({
      name: d.name,
      kind: d.isFile() ? "file" : d.isDirectory() ? "dir" : "other",
    })),
  };
}

const TREE_KIND: Record<string, CodeDirEntry["kind"]> = {
  blob: "file",
  tree: "dir",
};

/** One folder's entries as of `ref` (resolved), from git's tree (unsorted). */
export async function listAtRef(
  wtPath: string,
  dir: string,
  ref: string,
): Promise<ListResult> {
  // `<ref>:<dir>` names the tree object itself, so its entries come back as
  // bare names; a path that is not a tree at that ref fails the spawn.
  const result = await spawnCaptured(
    [
      GIT,
      "--no-optional-locks",
      "-C",
      resolve(wtPath),
      "ls-tree",
      "-z",
      "--format=%(objecttype)%x09%(path)",
      `${ref}:${dir}`,
    ],
    { timeoutMs: GIT_TIMEOUT_MS },
  );
  if (result.exitCode !== 0) return { kind: "missing" };
  const entries = result.stdout
    .split("\0")
    .filter((line) => line !== "")
    .map((line): CodeDirEntry => {
      const tab = line.indexOf("\t");
      return {
        name: line.slice(tab + 1),
        kind: TREE_KIND[line.slice(0, tab)] ?? "other",
      };
    });
  return { kind: "ok", entries };
}
