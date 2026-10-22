import { z } from "zod";
import {
  defineEndpoint,
  multipart,
  blob,
} from "@plugins/infra/plugins/endpoints/core";
import {
  SavedWallpaperSchema,
  WallpaperAttributionSchema,
  type WallpaperAttribution,
} from "./config";

/**
 * A candidate produced by a provider Panel and handed to the picker's centralized
 * save. A `remote` candidate is imported server-side (SSRF-guarded fetch); a
 * `file` candidate is uploaded as multipart. Attribution rides along either way.
 */
export type WallpaperCandidate =
  | { kind: "remote"; url: string; attribution?: WallpaperAttribution }
  | { kind: "file"; file: File; attribution?: WallpaperAttribution }
  // A bundled wallpaper: no server save, the picker writes its id to config.
  | { kind: "builtin"; id: string; attribution?: undefined };

/**
 * Import a remote image URL (an Openverse pick OR a pasted URL) into the store.
 * The handler validates the URL (public), fetches it SSRF-guarded, asserts an
 * `image/*` content-type under a byte cap, and writes the bytes. Returns the new
 * version + mime; the web picker writes config afterwards.
 */
export const importWallpaperUrl = defineEndpoint({
  route: "POST /api/wallpaper/import-url",
  body: z.object({
    url: z.string().url(),
    attribution: WallpaperAttributionSchema.optional(),
  }),
  response: SavedWallpaperSchema,
});

/**
 * Upload a local image file into the store (multipart, field name `file`). The
 * handler validates the File is an image and writes the bytes. Returns the new
 * version + mime; the web picker writes config afterwards.
 */
export const uploadWallpaper = defineEndpoint({
  route: "POST /api/wallpaper/upload",
  body: multipart(),
  response: SavedWallpaperSchema,
});

/**
 * Serve the current wallpaper image, streamed same-origin. The client cache-busts
 * with `?v=<version>` (written into config on save). Declared here so the route is
 * a typed contract; the server keeps a raw `blob()` handler (custom content-type +
 * cache-control headers), which the endpoints contract permits.
 */
export const wallpaperImage = defineEndpoint({
  route: "GET /api/wallpaper/image",
  query: z.object({ v: z.string().optional() }),
  response: blob(),
});
