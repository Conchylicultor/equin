import { z } from "zod";

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
 * A user-chosen path read from JSON (a config value, a wire field): a string,
 * branded on the way in. (`z.string().brand()` would carry the brand on its
 * `_zod.output` only, not the `ZodType<T>` output a field schema is typed by.)
 */
export const UserPathSchema = z.string().transform(asUserPath);
