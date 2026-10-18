import { stat } from "node:fs/promises";
import { wallpaperImagePath, readWallpaperMime } from "./store";

/**
 * Stream the current wallpaper image with its stored mime. A raw handler (not
 * `implement`) because it serves binary with a custom content-type + cache
 * headers. The client cache-busts via the `?v=<version>` query (written into
 * config on save), so we mark the body immutable for a year — a new version is a
 * new URL. Returns 404 when no wallpaper has been set.
 */
export async function handleImage(): Promise<Response> {
  const mime = await readWallpaperMime();
  if (!mime) return new Response("no wallpaper set", { status: 404 });

  const path = wallpaperImagePath();
  try {
    await stat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return new Response("wallpaper file missing on disk", { status: 410 });
  }

  return new Response(Bun.file(path), {
    headers: {
      "content-type": mime,
      "cache-control": "private, max-age=31536000, immutable",
    },
  });
}
