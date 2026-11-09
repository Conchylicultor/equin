import { z } from "zod";

/**
 * The file systems a file can live in — a closed set both runtimes name (the
 * reads are declared per system in `./reads.ts`):
 *
 * - `computer` — the computer's disk: absolute paths, or `~`-rooted under the
 *   user's home. Served by host-fs's machine half (desktop only).
 * - `browser` — a browser host's own storage, laid out like a home folder:
 *   `~` is its root, the apps' folders sit under the hidden `~/.equin/`
 *   (data-files' roots, at their data dir). Served only by a browser host.
 * - `checkout` — one checkout's files (`checkout` is the workspace id the code
 *   reads take: an attempt id, `"main"`, `"self"`, or a checkout's absolute
 *   root), read as on disk now or AS OF `version` (a git ref: `HEAD`, `main`,
 *   a sha). Read-only, served by code-explorer's machine half.
 */
export type FileSystemKind = "computer" | "browser" | "checkout";

/**
 * Where a file is: a path in one file system. What every file reader takes
 * (file-viewer's renderers, the Files preview) — it hands the location to the
 * reads (`useFileText`, `useFileBytes`, `fileUrl`) and never branches on `fs`.
 */
export type FileLocation =
  | { fs: "computer"; path: string }
  | { fs: "browser"; path: string }
  | { fs: "checkout"; checkout: string; path: string; version?: string };

/** A {@link FileLocation} as a question (a live value's query). */
export const FileLocationSchema = z.discriminatedUnion("fs", [
  z.object({ fs: z.literal("computer"), path: z.string() }),
  z.object({ fs: z.literal("browser"), path: z.string() }),
  z.object({
    fs: z.literal("checkout"),
    checkout: z.string(),
    path: z.string(),
    version: z.string().optional(),
  }),
]) satisfies z.ZodType<FileLocation>;

/** The location's basename. */
export function locationName(location: FileLocation): string {
  return location.path.slice(location.path.lastIndexOf("/") + 1);
}

/**
 * One string that identifies the file a location names — for React keys and
 * for resetting per-file state when the file changes.
 */
export function locationKey(location: FileLocation): string {
  switch (location.fs) {
    case "computer":
    case "browser":
      return `${location.fs}:${location.path}`;
    case "checkout":
      return `checkout:${location.checkout}:${location.version ?? ""}:${location.path}`;
  }
}

/** Whether two locations name the same file (as {@link locationKey} does). */
export function sameLocation(a: FileLocation, b: FileLocation): boolean {
  return locationKey(a) === locationKey(b);
}

/**
 * Whether the file system hands a file to the computer's own apps (Open with
 * default app, Reveal in Finder) — only the computer's disk does; a file in
 * the browser's storage or a checkout's version has no file of its own there.
 */
export function opensNatively(
  location: FileLocation,
): location is Extract<FileLocation, { fs: "computer" }> {
  return location.fs === "computer";
}
