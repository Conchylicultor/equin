import { prototypesFiles } from "@plugins/apps/plugins/prototypes/server";
import { relPath } from "@plugins/infra/plugins/paths/plugins/data-files/core";
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

/** A prototype folder exists under this id (a minted `proto-…` name). */
export async function prototypeExists(name: string): Promise<boolean> {
  if (!protoIdKind.is(name)) return false;
  const stat = await prototypesFiles.stat(relPath(name));
  return stat.kind === "found" && stat.entry.kind === "dir";
}
