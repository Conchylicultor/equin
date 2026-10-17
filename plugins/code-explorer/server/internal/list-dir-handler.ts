import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { Dirent } from "node:fs";
import { implement, HttpError } from "@plugins/infra/plugins/endpoints/server";
import {
  listCodeDir,
  type CodeDirEntry,
} from "@plugins/code-explorer/plugins/code-api/core";
import { GIT } from "@plugins/infra/plugins/paths/server";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import { resolveInsideRoot } from "./contained-path";
import { ALLOWED_REFS, resolveRef } from "./resolve-ref";
import {
  resolveWorkspacePath,
  resolveWorktreePath,
} from "./resolve-worktree-path";

// A local metadata read serving an open HTTP request; only a wedged child
// reaches this, and it then fails as a named error (see get-file-content.ts).
const GIT_TIMEOUT_MS = 30_000;

type ListResult = { kind: "ok"; entries: CodeDirEntry[] } | { kind: "missing" };

export const handleListDir = implement(
  listCodeDir,
  async ({ params, query }) => {
    const { worktree } = params;
    if (!worktree) throw new HttpError(400, "Missing worktree");

    // A listing as of a ref reads git's tree, so needs a checkout; one on
    // disk lists any workspace kind.
    const wtPath = await (query.ref !== undefined
      ? resolveWorktreePath(worktree)
      : resolveWorkspacePath(worktree));
    if (!wtPath) throw new HttpError(404, "Not found");

    // Inside the checkout only: `""` is its root, anything else must resolve
    // under it.
    const dir = query.dir.replace(/\/+$/, "");
    const absDir =
      dir === "" ? resolve(wtPath) : resolveInsideRoot(wtPath, dir);
    if (absDir === null) throw new HttpError(400, "Invalid path");

    let result: ListResult;
    if (query.ref !== undefined) {
      if (!ALLOWED_REFS.has(query.ref)) throw new HttpError(400, "Invalid ref");
      result = await listAtRef(
        wtPath,
        dir,
        await resolveRef(wtPath, query.ref),
      );
    } else {
      result = await listOnDisk(absDir);
    }
    if (result.kind === "ok")
      result.entries.sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
      );
    return result;
  },
);

async function listOnDisk(absDir: string): Promise<ListResult> {
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

async function listAtRef(
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
