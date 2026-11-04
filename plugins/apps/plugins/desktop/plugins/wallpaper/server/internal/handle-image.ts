import { readWallpaper } from "./store";

/**
 * `GET /api/wallpaper/image` — the current uploaded / imported wallpaper. 404
 * when none was ever saved, 410 when its sidecar outlived the image. The `?v=`
 * the client appends is a cache-bust only (a new save is a new version), so the
 * answer is immutable.
 */
export async function handleImage(): Promise<Response> {
  const current = await readWallpaper();
  if (current.kind === "unset")
    return new Response("no wallpaper set", { status: 404 });
  if (current.kind === "missing")
    return new Response("wallpaper file missing", { status: 410 });
  return new Response(current.blob, {
    headers: {
      "content-type": current.mime,
      "cache-control": "private, max-age=31536000, immutable",
    },
  });
}
