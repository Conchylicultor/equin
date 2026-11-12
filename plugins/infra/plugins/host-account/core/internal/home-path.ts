/**
 * Host paths as a person reads them: `~` for the home directory (`hostHome`)
 * and `~/…` below it, an absolute path anywhere else. host-fs accepts both
 * forms; comparing two paths, or showing one, needs the home directory.
 */

/** The home directory, in its display form. */
export const HOME = "~";

/**
 * `path` with `~` expanded against `home`. A home at the root (`/` — a file
 * system whose home IS its root, the browser's storage) expands `~/a` to `/a`.
 */
export function absolutePath(path: string, home: string): string {
  if (path === HOME) return home;
  if (path.startsWith(`${HOME}/`)) {
    return home === "/" ? path.slice(1) : `${home}${path.slice(1)}`;
  }
  return path;
}

/** `path` with the home directory collapsed to `~` — the form a path is shown in. */
export function displayPath(path: string, home: string): string {
  const abs = absolutePath(path, home);
  if (abs === home) return HOME;
  if (home === "/") return abs.startsWith("/") ? `${HOME}${abs}` : abs;
  if (abs.startsWith(`${home}/`)) return `${HOME}${abs.slice(home.length)}`;
  return abs;
}

/**
 * Free text with every occurrence of the home directory collapsed to `~` — for
 * prose that merely MENTIONS paths (a transcript, a command's output), where
 * {@link displayPath} (one whole path) does not apply. Only a whole path
 * segment matches: `/h/me` is collapsed in `/h/me/a` and `cd /h/me;` but not in
 * `/h/meow`. Display only — never feed the result back to the filesystem.
 */
export function tildifyText(text: string, home: string): string {
  if (home === "" || home === "/") return text;
  const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(
    new RegExp(`(?<![\\w.~-])${escaped}(?![\\w.-])`, "g"),
    HOME,
  );
}
