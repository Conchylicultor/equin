/**
 * Host paths as the file explorer spells them (the home-relative form and its
 * conversions are host-account's: `HOME`, `absolutePath`, `displayPath`). A location is written the way a
 * person reads it: `~` for the home directory and `~/…` below it, an absolute
 * path anywhere else. host-fs accepts both forms, so a path is never resolved
 * just to be listed — only compared, which needs the home directory.
 */

import { HOME } from "@plugins/infra/plugins/host-account/core";

/** `name` inside `dir`. */
export function joinPath(dir: string, name: string): string {
  return dir === "/" ? `/${name}` : `${dir}/${name}`;
}

/** The last segment of a path: `~` for home, `/` for the root. */
export function baseName(path: string): string {
  if (path === HOME || path === "/") return path;
  const cut = path.lastIndexOf("/");
  return cut < 0 ? path : path.slice(cut + 1);
}

/** The directory holding `path`, in the same form; `null` at the filesystem root. */
export function parentPath(path: string, home: string): string | null {
  if (path === "/") return null;
  if (path === HOME) return parentPath(home, home);
  const cut = path.lastIndexOf("/");
  if (path.startsWith(`${HOME}/`) && cut === 1) return HOME;
  if (cut <= 0) return "/";
  return path.slice(0, cut);
}

/** Whether `path` is `dir` or below it (both in the same form). */
export function isWithin(path: string, dir: string): boolean {
  if (path === dir) return true;
  return path.startsWith(dir === "/" ? "/" : `${dir}/`);
}

/** The crumbs of a path, root first, each with the path it stands for. */
export function pathChain(path: string): string[] {
  const chain: string[] = [];
  let rest: string = path;
  for (;;) {
    chain.unshift(rest);
    if (rest === HOME || rest === "/") return chain;
    const cut = rest.lastIndexOf("/");
    if (cut < 0) return chain;
    rest = cut === 0 ? "/" : rest.slice(0, cut);
  }
}
