/**
 * Whether a source file is built for the browser: a plugin's `web/`, `core/`,
 * `shared/` or `exhibits/` folder — the folders
 * the web artifacts inline or serve as barrels (`core/` and `shared/` are
 * imported by `web/`, `exhibits/` is co-built into it).
 *
 * Pure segment arithmetic, so the rule loads under jiti and Bun alike.
 */

const BROWSER_FOLDERS = new Set(["web", "core", "shared", "exhibits"]);

/** `file` relative to `cwd` (the repo root ESLint runs from), posix. */
function inRepo(file: string, cwd: string): string {
  const posix = file.split("\\").join("/");
  const root = cwd.split("\\").join("/").replace(/\/$/, "");
  return posix.startsWith(`${root}/`) ? posix.slice(root.length + 1) : posix;
}

export function isBrowserBuilt(file: string, cwd: string): boolean {
  const segs = inRepo(file, cwd).split("/");
  if (segs[0] !== "plugins" || segs[1] === undefined) return false;
  // The plugin dir is `<name>(/plugins/<name>)*`; the segment after it is
  // the folder the file sits in.
  let i = 1;
  while (segs[i + 1] === "plugins" && segs[i + 2] !== undefined) i += 2;
  const folder = segs[i + 1];
  return folder !== undefined && BROWSER_FOLDERS.has(folder);
}
