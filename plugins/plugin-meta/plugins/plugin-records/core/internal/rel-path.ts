/**
 * Repo-relative posix paths, in plain string operations: the module graph
 * resolves imports against the repo's file set, never the disk, so it needs no
 * `node:path` (and `core/` may not import it).
 */

/** The directory of a repo-relative path ("" for a top-level file). */
export function relDirname(rel: string): string {
  const cut = rel.lastIndexOf("/");
  return cut < 0 ? "" : rel.slice(0, cut);
}

/**
 * `spec` joined onto the repo-relative directory `dir`, normalized — or null
 * when it climbs out of the repo.
 */
export function relJoin(dir: string, spec: string): string | null {
  const out = dir === "" ? [] : dir.split("/");
  for (const seg of spec.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.length === 0 ? null : out.join("/");
}
