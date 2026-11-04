import { implementMachine } from "@plugins/infra/plugins/endpoints/machine";
import { importWallpaperUrl } from "../../core";
import { writeWallpaper } from "../../server";
import { downloadImage } from "./download";

/** Download a remote image (SSRF-guarded) and save it as the wallpaper. */
export const handleImportUrl = implementMachine(
  importWallpaperUrl,
  async ({ body }) => {
    const { bytes, mime } = await downloadImage(body.url);
    return writeWallpaper(bytes, mime);
  },
);
