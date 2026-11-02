import type { z } from "zod";

/**
 * A host path the user (or their config) chose — not one the app owns.
 *
 * The brand is what `user-path/no-sync-fs` reads: such a path may sit in a
 * folder macOS gates behind Files & Folders (Downloads, Documents, Desktop,
 * removable and network volumes), and while macOS's "allow access?" prompt is
 * up, a synchronous fs call on it blocks the whole JS thread until someone
 * answers — 5.5 h on 2026-10-11. So a `UserPath` (and every path derived from
 * one) only ever reaches the async `node:fs/promises` API, and server code
 * that takes one says so in its signature.
 *
 * A plain string at runtime: the brand is types only, so it serializes, is
 * stored in config and travels to the browser unchanged.
 */
export type UserPath = string & z.$brand<"UserPath">;

/**
 * Mark a path as user-chosen — where one enters the backend (a request
 * parameter, a config value read without its schema) or is rebuilt from one
 * (`asUserPath(join(dir, name))`). Adding the brand is always safe; it is
 * dropping it that the lint rule refuses.
 */
export function asUserPath(path: string): UserPath {
  return path as UserPath;
}

/**
 * A host path the app itself owns — its data dirs, its checkout, a temp dir it
 * minted, a fixed system path — never one a user chose.
 *
 * The only path a synchronous fs call on a backend's JS thread may take
 * (`user-path/no-sync-fs`): the check is an allow-list, so a path nobody
 * proved is refused rather than trusted. The brand starts at the app's path
 * sources (the paths module, data dirs, the git roots) and follows every
 * signature declared `AppPath`.
 */
export type AppPath = string & z.$brand<"AppPath">;

/**
 * Type a path `AppPath`. Where `user-path/no-unproven-claim` can prove the
 * argument app-owned (a temp dir, `realpath` / `dirname` / `${p}.tmp` of an
 * `AppPath`, `import.meta.dir`…) this only gives tsc the type. Anything else
 * is a CLAIM, refused unless the file declares it — a `sanctioned` exemption
 * of that rule in its plugin's `exempt/index.ts`, with the reason. A
 * user-chosen path (`UserPath`) is never claimable.
 */
export function asAppPath(path: string): AppPath {
  return path as AppPath;
}

/**
 * A path under an app-owned one: `join(dir, ...segments)` (POSIX), still
 * app-owned. The segments name entries under it (a file name, an id — any
 * string); an absolute segment stays under `dir`, and a `..` segment, the one
 * way out, throws. The lint proves a bare `join(dir, x)` only for a literal
 * or literal-typed `x`, so a path built from an id or a stored name comes
 * through here.
 * Written out rather than calling `node:path`, which a `core/` module may not
 * import (`boundaries/no-platform-api`); `node:path`'s `join` is the
 * reference its test holds it to.
 */
export function joinAppPath(dir: AppPath, ...segments: string[]): AppPath {
  for (const segment of segments)
    if (segment.split("/").includes(".."))
      throw new Error(
        `joinAppPath: segment ${JSON.stringify(segment)} climbs out of ${dir} — a path under an app-owned dir names entries in it; take the parent with dirname`,
      );
  return posixJoin([dir, ...segments]) as AppPath;
}

/**
 * The directory holding an app-owned path (POSIX `dirname`): app-owned too —
 * the one way up, where `joinAppPath` refuses a `..`.
 */
export function appPathParent(path: AppPath): AppPath {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path;
  const at = trimmed.lastIndexOf("/");
  if (at < 0) return "." as AppPath;
  if (at === 0) return "/" as AppPath;
  return trimmed.slice(0, at) as AppPath;
}

/** `node:path`'s POSIX `join`: the non-empty parts joined by `/`, normalized. */
function posixJoin(parts: readonly string[]): string {
  const joined = parts.filter((p) => p !== "").join("/");
  if (joined === "") return ".";
  const absolute = joined.startsWith("/");
  const trailing = joined.endsWith("/");
  const out: string[] = [];
  for (const segment of joined.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!absolute) out.push("..");
      continue;
    }
    out.push(segment);
  }
  let path = out.join("/");
  if (path === "" && !absolute) path = ".";
  if (trailing && path !== "" && path !== ".") path += "/";
  else if (trailing && path === ".") path = "./";
  return absolute ? `/${path}` : path;
}
