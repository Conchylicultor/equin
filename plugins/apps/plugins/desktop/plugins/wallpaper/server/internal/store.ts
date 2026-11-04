import { relPath } from "@plugins/infra/plugins/paths/plugins/data-files/core";
import { desktopFiles } from "./roots";

// The wallpaper store, at `wallpaper/` in the desktop app's one data dir
// (`desktopFiles`). A SINGLETON: there is exactly one current desktop
// wallpaper, so the image always lands at the same path (a fixed name) and is
// overwritten on each save. The mime is sidecar metadata so the image route
// can serve the right content-type after a restart.
const imagePath = relPath("wallpaper", "current");
const metaPath = relPath("wallpaper", "current.json");

interface WallpaperMeta {
  mime: string;
  version: number;
}

const WRITER = { kind: "system", reason: "a wallpaper save" } as const;

async function readMeta(): Promise<WallpaperMeta | null> {
  const read = await desktopFiles.read(metaPath);
  if (read.kind === "missing") return null;
  const meta = JSON.parse(await read.blob.text()) as Partial<WallpaperMeta>;
  if (typeof meta.mime !== "string" || !meta.mime) return null;
  return { mime: meta.mime, version: meta.version ?? 0 };
}

/**
 * Persist image bytes as the current wallpaper, replacing whatever was there.
 * Writes the bytes plus a sidecar `current.json` carrying the mime and a
 * monotonically-incremented version stamp (the cache-bust `?v=` the client reads
 * back). Returns the new version + mime; the web picker writes them into config.
 */
export async function writeWallpaper(
  bytes: Uint8Array,
  mime: string,
): Promise<{ version: number; mime: string }> {
  const prev = await readMeta();
  const version = (prev?.version ?? 0) + 1;
  await desktopFiles.write(imagePath, bytes, { writer: WRITER });
  const meta: WallpaperMeta = { mime, version };
  await desktopFiles.write(
    metaPath,
    new TextEncoder().encode(JSON.stringify(meta)),
    { writer: WRITER },
  );
  return { version, mime };
}

/**
 * The current image and its mime, or why there is none: `unset` (no sidecar —
 * no wallpaper was ever saved) or `missing` (a sidecar without its image).
 */
export async function readWallpaper(): Promise<
  | { kind: "image"; blob: Blob; mime: string }
  | { kind: "unset" }
  | { kind: "missing" }
> {
  const meta = await readMeta();
  if (!meta) return { kind: "unset" };
  const read = await desktopFiles.read(imagePath);
  if (read.kind === "missing") return { kind: "missing" };
  return { kind: "image", blob: read.blob, mime: meta.mime };
}
