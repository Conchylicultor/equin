import type { FileLocation } from "@plugins/infra/plugins/paths/plugins/file-systems/core";

/**
 * The location of a path as a conversation, a tool call or a markdown document
 * spells it — relative to a checkout, absolute, or `~`-prefixed — so whatever
 * reads it goes to the file system that actually holds it:
 *
 * - relative → the `checkout` (`checkout` is the workspace id the code reads
 *   take);
 * - absolute and inside `opts.root` (the checkout's absolute root, when the
 *   caller knows it) → the `checkout`, relativized;
 * - any other absolute or `~` path → the `computer` (its disk, which expands
 *   `~`).
 *
 * A `~` path is never matched against `root`: the browser cannot expand it,
 * and its bytes read the same from the computer. Callers that only hold an
 * id (`"main"`, an attempt id) and no root send every absolute path to the
 * computer.
 */
export function locationForPath(
  checkout: string,
  path: string,
  opts: { root?: string } = {},
): FileLocation {
  if (path === "~" || path.startsWith("~/")) return { fs: "computer", path };
  if (!path.startsWith("/")) return { fs: "checkout", checkout, path };
  const abs = normalizeAbsolute(path);
  if (opts.root !== undefined) {
    const root = normalizeAbsolute(opts.root);
    const prefix = root === "/" ? "/" : `${root}/`;
    if (abs.startsWith(prefix) && abs.length > prefix.length) {
      return { fs: "checkout", checkout, path: abs.slice(prefix.length) };
    }
  }
  return { fs: "computer", path: abs };
}

/** `.`/`..`/empty segments collapsed and any trailing slash dropped. */
function normalizeAbsolute(path: string): string {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return `/${out.join("/")}`;
}
