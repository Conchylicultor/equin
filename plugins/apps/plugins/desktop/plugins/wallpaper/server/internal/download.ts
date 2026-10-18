import { HttpError } from "@plugins/infra/plugins/endpoints/server";
import {
  parsePublicUrl,
  safeFetch,
  SsrfError,
} from "@plugins/infra/plugins/safe-fetch/server";

/** Cap downloaded wallpaper images so a giant file can't exhaust memory/disk. */
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

/**
 * Fetch a remote image URL SSRF-guarded and return its bytes + mime. Error
 * convention mirrors `page/bookmark`'s scrape: an SSRF rejection, a network
 * `TypeError`, or an `AbortError` becomes a clean `HttpError` (a 4xx the picker
 * surfaces as a toast, wallpaper unchanged); any unexpected error rethrows.
 */
export async function downloadImage(
  rawUrl: string,
): Promise<{ bytes: Uint8Array; mime: string }> {
  let parsed: URL;
  try {
    parsed = parsePublicUrl(rawUrl);
  } catch (err) {
    if (err instanceof SsrfError) {
      throw new HttpError(400, `Blocked URL: ${err.message}`);
    }
    if (err instanceof TypeError) {
      throw new HttpError(400, "Invalid URL");
    }
    throw err;
  }

  let res: Response;
  try {
    res = await safeFetch(parsed);
  } catch (err) {
    if (err instanceof SsrfError) {
      throw new HttpError(400, `Blocked URL: ${err.message}`);
    }
    // Network failures surface to fetch as a TypeError; an aborted/timed-out
    // request as an AbortError. Both are expected upstream conditions → 502.
    if (err instanceof TypeError) {
      throw new HttpError(502, "Failed to fetch image");
    }
    if (err instanceof Error && err.name === "AbortError") {
      throw new HttpError(504, "Timed out fetching image");
    }
    throw err;
  }

  if (!res.ok) {
    throw new HttpError(502, `Failed to fetch image (status ${res.status})`);
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.startsWith("image/")) {
    throw new HttpError(400, "URL did not resolve to an image");
  }

  const buf = await res.arrayBuffer();
  if (buf.byteLength === 0) {
    throw new HttpError(400, "Empty image");
  }
  if (buf.byteLength > MAX_IMAGE_BYTES) {
    throw new HttpError(413, "Image is too large");
  }

  const mime = contentType.split(";")[0]?.trim() || "application/octet-stream";
  return { bytes: new Uint8Array(buf), mime };
}
