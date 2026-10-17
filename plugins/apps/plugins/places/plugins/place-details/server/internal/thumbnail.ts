import { rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { getMapsKey } from "@plugins/integrations/plugins/google-maps/server";
import { PlacesApiError } from "@plugins/integrations/plugins/google-maps/plugins/places-api/core";
import {
  placeFirstPhotoName,
  placePhoto,
} from "@plugins/integrations/plugins/google-maps/plugins/places-api/server";
import { createInflight } from "@plugins/packages/plugins/inflight/core";
import { GOOGLE_PLACE_ID_PATTERN } from "../../core";
import { placeThumbnailDir } from "../../data-dirs";

/** Thumbnail width: twice a gallery card's cover, for a sharp hi-dpi tile. */
const THUMBNAIL_WIDTH = 480;

/** How long "Google has no photo of it" is believed before asking again. */
const NO_PHOTO_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The image types Google serves place photos as, and their file extensions. */
const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

type Thumbnail =
  | { kind: "image"; file: ReturnType<typeof Bun.file> }
  | { kind: "no-photo" }
  | { kind: "maps-not-configured" };

// Concurrent asks for one place (a gallery opened in two tabs) share one fetch.
const inflight = createInflight();

/**
 * Serve one Google place's gallery thumbnail from the disk cache, fetching it
 * once on a miss: the photo names (free, IDs Only) then the first photo at
 * `THUMBNAIL_WIDTH` (one Place Photo call — the only billed one, ever, per
 * place). Long-lived browser cache on a hit: the bytes never change.
 */
export async function handlePlaceThumbnail(req: Request): Promise<Response> {
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!GOOGLE_PLACE_ID_PATTERN.test(id)) {
    return new Response("not a Google place id", { status: 400 });
  }
  const thumb = await inflight.run(id, () => thumbnail(id));
  switch (thumb.kind) {
    case "image":
      return new Response(thumb.file, {
        headers: { "cache-control": "private, max-age=2592000, immutable" },
      });
    case "no-photo":
      return new Response("no photo of this place", {
        status: 404,
        headers: { "cache-control": "private, max-age=86400" },
      });
    case "maps-not-configured":
      return new Response("Google Maps is not set up", { status: 503 });
  }
}

async function thumbnail(id: string): Promise<Thumbnail> {
  const cached = await readCached(id);
  if (cached !== null) return cached;

  const key = await getMapsKey();
  if (!key.ok) return { kind: "maps-not-configured" };
  let image: Response;
  try {
    const name = await placeFirstPhotoName(key.key, id);
    if (name === null) return await markNoPhoto(id);
    image = await placePhoto(key.key, name, THUMBNAIL_WIDTH);
  } catch (err) {
    // Google refused the id (it no longer knows the place) or the fresh photo
    // name: nothing to show, as with a place without photos.
    if (
      err instanceof PlacesApiError &&
      err.status >= 400 &&
      err.status < 500
    ) {
      return await markNoPhoto(id);
    }
    throw err;
  }
  const type = (image.headers.get("content-type") ?? "").split(";")[0] ?? "";
  const ext = EXTENSIONS[type];
  if (ext === undefined) {
    throw new Error(`Place photo for ${id} came back as ${type || "no type"}`);
  }
  const path = placeThumbnailDir.file(`${id}.${ext}`);
  await writeAtomic(path, new Uint8Array(await image.arrayBuffer()));
  return { kind: "image", file: Bun.file(path) };
}

/** The kept answer for `id`, or `null` when there is none (or it has expired). */
async function readCached(id: string): Promise<Thumbnail | null> {
  for (const ext of Object.values(EXTENSIONS)) {
    const file = Bun.file(placeThumbnailDir.file(`${id}.${ext}`));
    if (await file.exists()) return { kind: "image", file };
  }
  const none = Bun.file(placeThumbnailDir.file(`${id}.none`));
  if ((await none.exists()) && Date.now() - none.lastModified < NO_PHOTO_TTL_MS)
    return { kind: "no-photo" };
  return null;
}

async function markNoPhoto(id: string): Promise<Thumbnail> {
  await writeAtomic(placeThumbnailDir.file(`${id}.none`), new Uint8Array());
  return { kind: "no-photo" };
}

/** Temp file + rename: a concurrent reader never sees a half-written image. */
async function writeAtomic(path: string, bytes: Uint8Array): Promise<void> {
  placeThumbnailDir.ensure();
  const tmp = placeThumbnailDir.file(`.${randomUUID()}.tmp`);
  await Bun.write(tmp, bytes);
  await rename(tmp, path);
}
