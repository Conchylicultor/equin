import { assetMirrorCache } from "../../data-dirs";
import { mirrorFetchToDisk } from "../../server/internal/fetch-to-disk";
import { mirrorRegistry } from "../../server/internal/registry";

const MIME_BY_EXT: Record<string, string> = {
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".json": "application/json",
};

function contentType(name: string): string {
  const dot = name.lastIndexOf(".");
  const ext = dot === -1 ? "" : name.slice(dot).toLowerCase();
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

/**
 * Generic mirror route: `GET /api/asset-mirror/:id/:file` (and
 * `/:id/:dir/:file` for a path one directory deep).
 *
 * `params.file` arrives already `decodeURIComponent`'d (the server-core router
 * decodes path params), so it is the canonical flat file name (e.g.
 * `"PP C#1.ogg"`). On a cache miss we fetch `<remoteBase>/<encoded name>` —
 * re-encoding so the upstream CDN sees `PP%20C%231.ogg` — then atomically cache
 * and serve it. On any upstream failure we fail loudly: log + 502, never write.
 */
export async function handleMirror(
  _req: Request,
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

  const diskPath = assetMirrorCache.file(id, name);

  if (!(await Bun.file(diskPath).exists())) {
    // Cache miss → fetch from the registered remote source, then cache it. The
    // shared `mirrorFetchToDisk` helper does the fetch + atomic tmp+rename and
    // throws (fail loud) on any upstream failure; the route catches that to keep
    // its external contract: log + 502, never a partial write.
    try {
      await mirrorFetchToDisk({
        remoteBaseUrl: remoteBase,
        file: name,
        diskPath,
      });
    } catch (err) {
      console.error(
        `[asset-mirror:${id}] upstream fetch failed for "${name}": ${String(err)}`,
      );
      return new Response("upstream fetch failed", { status: 502 });
    }
  }

  return new Response(Bun.file(diskPath), {
    headers: {
      "content-type": contentType(name),
      // Mirrored assets are immutable; let the browser cache them indefinitely.
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}
