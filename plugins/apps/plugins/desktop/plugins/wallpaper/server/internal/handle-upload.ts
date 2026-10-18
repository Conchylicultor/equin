import { implement, HttpError } from "@plugins/infra/plugins/endpoints/server";
import { uploadWallpaper } from "../../core";
import { MAX_IMAGE_BYTES } from "./download";
import { writeWallpaper } from "./store";

/**
 * Upload a local image file (multipart, field name `file`) into the store. The
 * picker funnels `kind: "file"` candidates here. Validates the part is an image
 * under the byte cap, writes the bytes, and returns version + mime. Does NOT
 * write config — the web picker centralizes the `wallpaperConfig` write.
 */
export const handleUpload = implement(uploadWallpaper, async ({ body }) => {
  const file = body.get("file");
  if (!(file instanceof File)) {
    throw new HttpError(400, "Missing `file` upload");
  }
  const mime = file.type || "";
  if (!mime.startsWith("image/")) {
    throw new HttpError(400, "Uploaded file is not an image");
  }
  if (file.size === 0) {
    throw new HttpError(400, "Empty file");
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new HttpError(413, "Image is too large");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  return writeWallpaper(bytes, mime);
});
