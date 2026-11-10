import { createInflight } from "@plugins/packages/plugins/inflight/core";
import { rangedBlobResponse } from "@plugins/infra/plugins/endpoints/core";
import {
  relPath,
  type RelPath,
} from "@plugins/infra/plugins/paths/plugins/data-files/core";
import {
  cachedFileSegments,
  pinOf,
  remoteFileUrl,
  verifyPinnedBytes,
  type AssetMirrorSource,
} from "../../core";
import { mirrorRegistry } from "./registry";
import { assetMirrorFiles } from "./roots";

const MIME_BY_EXT: Record<string, string> = {
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".json": "application/json",
  ".js": "text/javascript",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

function contentType(name: string): string {
  const dot = name.lastIndexOf(".");
  const ext = dot === -1 ? "" : name.slice(dot).toLowerCase();
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

/** A miss being fetched, joined by every request for the same file meanwhile. */
const downloads = createInflight();

/**
 * Fetch one pinned file into the cache, under its digest. Throws on any
 * upstream failure or a digest mismatch — nothing is written then.
 */
async function download(
  source: AssetMirrorSource,
  name: string,
  path: RelPath,
): Promise<void> {
  const upstream = remoteFileUrl(source, name);
  const res = await fetch(upstream);
  if (!res.ok) throw new Error(`upstream ${res.status} (${upstream})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  await verifyPinnedBytes(source, name, bytes);
  await assetMirrorFiles.write(path, bytes, {
    writer: { kind: "system", reason: "an asset-mirror cache miss" },
  });
}

/**
 * Generic mirror route: `GET /api/asset-mirror/:id/:file` (and
 * `/:id/:dir/:file` for a path one directory deep), on every host.
 *
 * `params.file` arrives already `decodeURIComponent`'d (the router decodes
 * path params), so it is the canonical file name (e.g. `"PP C#1.ogg"`). A
 * name the mirror's source does not pin is a 404. On a cache miss the file is
 * fetched from the remote, checked against its pin and written to the cache
 * under its digest (atomically: a reader sees all of it or nothing), then
 * served — whole, or the one byte range a `Range` header asks for (a
 * `<video>` seeking). On any upstream failure or a pin mismatch we fail
 * loudly: log + 502, never write.
 */
export async function handleMirror(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  const id = params.id;
  const file = params.file;
  if (!id || !file) return new Response("missing id or file", { status: 400 });
  // One directory deep at most (the nested route key); each segment is flat.
  const segments = params.dir === undefined ? [file] : [params.dir, file];
  const name = segments.join("/");

  const source = mirrorRegistry.get(id);
  if (source === undefined) {
    return new Response(`unknown mirror: ${id}`, { status: 404 });
  }
  // Only a pinned name is served — which also rules out any path traversal:
  // every pinned name is validated flat at declaration.
  const sha256 = pinOf(source, name);
  if (sha256 === undefined) {
    return new Response(`not a file of mirror ${id}: ${name}`, {
      status: 404,
    });
  }
  const path = relPath(...cachedFileSegments(source, sha256));
  let cached = await assetMirrorFiles.read(path);
  if (cached.kind === "missing") {
    try {
      await downloads.run(path, () => download(source, name, path));
    } catch (err) {
      console.error(
        `[asset-mirror:${id}] upstream fetch failed for "${name}": ${String(err)}`,
      );
      return new Response("upstream fetch failed", { status: 502 });
    }
    cached = await assetMirrorFiles.read(path);
    if (cached.kind === "missing") {
      throw new Error(
        `[asset-mirror:${id}] "${name}" is missing right after it was cached`,
      );
    }
  }
  // Honours `Range`, so a mirrored video seeks (and plays at all in Safari).
  return rangedBlobResponse(cached.blob, req.headers.get("range"), {
    "content-type": contentType(name),
    // Pinned bytes are immutable; let the browser cache them indefinitely.
    "cache-control": "public, max-age=31536000, immutable",
  });
}
