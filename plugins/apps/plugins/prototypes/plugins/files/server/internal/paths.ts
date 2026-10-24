import { statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { prototypesDir } from "@plugins/apps/plugins/prototypes/data-dirs";
import type { IdOf } from "@plugins/ids/core";
import { protoIdKind } from "../../core";

// A prototype ships whatever it references, so the served set is not just code:
// images and a font are part of "self-contained". No `.jsx` — JSX lives inline
// in index.html (see the watcher, and the `prototypes:self-contained` check).
const MIME_BY_EXT: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".woff2": "font/woff2",
};

/** Content-Type for a served file, by extension. */
export function contentTypeForPath(path: string): string {
  const dot = path.lastIndexOf(".");
  const ext = dot === -1 ? "" : path.slice(dot).toLowerCase();
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

/**
 * Resolve `prototypes/<name>/<rel>` to an absolute path, guarding against
 * traversal. Returns `null` if the resolved path escapes {@link prototypesDir}.
 */
export function resolvePrototypeFile(name: string, rel: string): string | null {
  // Read the getter ONCE: the guard below compares against the same root the
  // path was resolved from, so both must come from a single read.
  const root = prototypesDir.path;
  const abs = resolve(root, name, rel);
  // Must stay strictly under the prototypes dir (not the dir itself, and not a
  // sibling whose name is a prefix, e.g. `prototypes-evil`).
  if (abs !== root && !abs.startsWith(root + sep)) {
    return null;
  }
  return abs;
}

/** A prototype folder exists under this id (a minted `proto-…` name). */
export function prototypeExists(
  name: string,
): name is IdOf<typeof protoIdKind> {
  if (!protoIdKind.is(name)) return false;
  const stat = statSync(prototypesDir.file(name), { throwIfNoEntry: false });
  return stat?.isDirectory() ?? false;
}
