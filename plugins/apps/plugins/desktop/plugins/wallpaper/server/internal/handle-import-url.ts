import { implement } from "@plugins/infra/plugins/endpoints/server";
import { importWallpaperUrl } from "../../core";
import { downloadImage } from "./download";
import { writeWallpaper } from "./store";

/**
 * Import a remote image URL into the store. Downloads it SSRF-guarded (validating
 * image content-type + byte cap inside {@link downloadImage}), writes the bytes,
 * and returns the new version + mime. Does NOT write config — the web picker
 * centralizes the `wallpaperConfig` write after a successful save.
 */
export const handleImportUrl = implement(importWallpaperUrl, async ({ body }) => {
  const { bytes, mime } = await downloadImage(body.url);
  return writeWallpaper(bytes, mime);
});
