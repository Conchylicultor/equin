import { createInflight } from "@plugins/packages/plugins/inflight/core";
import { rangedBlobResponse } from "@plugins/infra/plugins/endpoints/core";
import {
  relPath,
  type RelPath,
} from "@plugins/infra/plugins/paths/plugins/data-files/core";
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
 * Fetch `<remoteBase>/<encoded segments>` into the cache. The remote name is
 * re-encoded segment by segment, so a flat name with spaces or `#`
 * (`"PP C#1.ogg"`) reaches the CDN as `PP%20C%231.ogg` and a nested one
 * (`en/data.json`) keeps its `/`. Throws on any upstream failure — nothing is
 * written then.
 */
async function download(
  remoteBase: string,
  segments: readonly string[],
  path: RelPath,
): Promise<void> {
  const upstream = `${remoteBase}/${segments.map(encodeURIComponent).join("/")}`;
  const res = await fetch(upstream);
  if (!res.ok) {
    throw new Error(`upstream ${res.status} (${upstream})`);
  }
  await assetMirrorFiles.write(path, new Uint8Array(await res.arrayBuffer()), {
    writer: { kind: "system", reason: "an asset-mirror cache miss" },
  });
}

/**
 * Generic mirror route: `GET /api/asset-mirror/:id/:file` (and
 * `/:id/:dir/:file` for a path one directory deep), on every host.
 *
 * `params.file` arrives already `decodeURIComponent`'d (the router decodes
 * path params), so it is the canonical flat file name (e.g. `"PP C#1.ogg"`).
 * On a cache miss the file is fetched from the registered remote source and
 * written to the cache (atomically: a reader sees all of it or nothing), then
 * served — whole, or the one byte range a `Range` header asks for (a
 * `<video>` seeking). On any upstream failure we fail loudly: log + 502, never
 * write.
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

  const remoteBase = mirrorRegistry.get(id);
  if (remoteBase === undefined) {
    return new Response(`unknown mirror: ${id}`, { status: 404 });
  }

  // Path-traversal guard: every segment is a single flat name.
  if (
    segments.some(
      (s) =>
        s.length === 0 ||
        s.includes("/") ||
        s.includes("\\") ||
        s.includes(".."),
    )
  ) {
    return new Response("invalid file", { status: 400 });
  }

  const path = relPath(id, ...segments);
  // A cached directory (`en/` once `en/data.json` is) is no mirrored file.
  const stat = await assetMirrorFiles.stat(path);
  if (stat.kind === "found" && stat.entry.kind === "dir") {
    return new Response("not a file", { status: 404 });
  }
  let cached = await assetMirrorFiles.read(path);
  if (cached.kind === "missing") {
    try {
      await downloads.run(`${id}/${name}`, () =>
        download(remoteBase, segments, path),
      );
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
    // Mirrored assets are immutable; let the browser cache them indefinitely.
    "cache-control": "public, max-age=31536000, immutable",
  });
}
