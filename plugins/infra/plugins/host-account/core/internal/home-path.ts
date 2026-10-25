/**
 * Host paths as a person reads them: `~` for the home directory (`hostHome`)
 * and `~/…` below it, an absolute path anywhere else. host-fs accepts both
 * forms; comparing two paths, or showing one, needs the home directory.
 */

/** The home directory, in its display form. */
export const HOME = "~";

/** `path` with `~` expanded against `home`. */
export function absolutePath(path: string, home: string): string {
  if (path === HOME) return home;
  if (path.startsWith(`${HOME}/`)) return `${home}${path.slice(1)}`;
  return path;
}

/** `path` with the home directory collapsed to `~` — the form a path is shown in. */
export function displayPath(path: string, home: string): string {
  const abs = absolutePath(path, home);
  if (abs === home) return HOME;
  if (abs.startsWith(`${home}/`)) return `${HOME}${abs.slice(home.length)}`;
  return abs;
}
