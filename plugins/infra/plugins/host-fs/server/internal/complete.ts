import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { HttpError } from "@plugins/infra/plugins/endpoints/server";
import { HOST_FS_COMPLETE_LIMIT, type HostFsCompleteResult } from "../../core";
import { followLink } from "./entry";
import { classifyFsError, isHiddenName, resolveHostPath } from "./path";

/**
 * Split a typed prefix into the directory to search and the name fragment to
 * match: `~/Doc` → (`$HOME`, `Doc`); `/usr/` → (`/usr`, ``). The fragment is
 * taken before normalisation, since `resolve` would drop the trailing slash
 * that says "complete inside this directory".
 */
export function splitPrefix(
  prefix: string,
  home?: string,
): { dir: string; fragment: string } {
  if (prefix === "") throw new HttpError(400, "Prefix must not be empty");
  if (prefix === "~") return { dir: resolveHostPath("~", home), fragment: "" };
  const slash = prefix.lastIndexOf("/");
  if (slash < 0)
    throw new HttpError(
      400,
      `Prefix must be absolute or start with ~: ${prefix}`,
    );
  const dirPart = prefix.slice(0, slash + 1);
  return {
    dir: resolveHostPath(dirPart, home),
    fragment: prefix.slice(slash + 1),
  };
}

/** Folder-only children of `dir` whose name starts with `fragment`, case-insensitively. */
export async function completeHostDir(
  dir: string,
  fragment: string,
  limit: number = HOST_FS_COMPLETE_LIMIT,
): Promise<HostFsCompleteResult> {
  const needle = fragment.toLowerCase();
  const showHidden = isHiddenName(fragment);
  try {
    const st = await stat(dir);
    if (!st.isDirectory()) return { kind: "not-a-dir", path: dir };
    const dirents = await readdir(dir, { withFileTypes: true });
    const candidates = dirents.filter(
      (d) =>
        d.name.toLowerCase().startsWith(needle) &&
        (showHidden || !isHiddenName(d.name)),
    );
    const dirs = (
      await Promise.all(
        candidates.map(async (d) =>
          (await isDirLike(dir, d)) ? d.name : null,
        ),
      )
    )
      .filter((name): name is string => name !== null)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return {
      kind: "ok",
      dir,
      matches: dirs
        .slice(0, limit)
        .map((name) => ({ name, path: join(dir, name) })),
      truncated: dirs.length > limit,
    };
  } catch (err) {
    return { kind: classifyFsError(err), path: dir };
  }
}

/** A directory, or a symlink that resolves to one (an unresolvable link is not). */
async function isDirLike(dir: string, d: Dirent): Promise<boolean> {
  if (d.isDirectory()) return true;
  if (!d.isSymbolicLink()) return false;
  const target = await followLink(join(dir, d.name));
  return target.kind === "resolved" && target.stats.isDirectory();
}
