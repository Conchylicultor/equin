import { dataUriToBlob, dataUriType, type OpenVia } from "../../core";

/**
 * The viewer's three file actions. Which of them a given image may use is
 * decided by `imageCapabilities` (core); these only carry them out.
 */

/**
 * Copy the image to the clipboard as PNG, the one image type every clipboard
 * accepts. A `data:image/png` source is decoded as-is; anything else is
 * re-encoded by drawing the already-loaded viewer `<img>` onto a canvas — no
 * second download.
 *
 * The PNG is handed to `ClipboardItem` as a promise, not awaited first: Safari
 * only allows the write while the click's user activation is still live, which
 * an `await` before `write()` would spend.
 *
 * Throws what the browser throws. The caller decides which of those is an
 * expected refusal (`NotAllowedError`) and lets the rest surface.
 */
export async function copyImage(
  img: HTMLImageElement,
  src: string,
): Promise<void> {
  const png =
    src.startsWith("data:") && dataUriType(src) === "image/png"
      ? Promise.resolve(dataUriToBlob(src))
      : encodePng(img);
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}

function encodePng(img: HTMLImageElement): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx)
    throw new Error("Could not get a 2D canvas context to encode the image");
  ctx.drawImage(img, 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("The browser produced no PNG for this image"));
    }, "image/png");
  });
}

/** Save the image under `name`, through the browser's own download. */
export function downloadImage(src: string, name: string): void {
  const a = document.createElement("a");
  a.href = src;
  a.download = name;
  a.rel = "noopener";
  a.click();
}

/** How long a `blob:` URL made for "Open original" stays valid: long enough
 *  for the new tab to load it, after which the tab holds its own copy. */
const OPENED_BLOB_TTL_MS = 60_000;

/** Where "Open original" goes: the image by itself. A thunk, evaluated inside
 *  the click, because a `data:` image is first made into a `blob:` URL (a
 *  browser will not navigate a tab to a `data:` URI) that must exist only once
 *  the user asks. */
export function originalHref(
  src: string,
  via: Exclude<OpenVia, "none">,
): () => string {
  if (via === "url") return () => src;
  return () => {
    const url = URL.createObjectURL(dataUriToBlob(src));
    window.setTimeout(() => URL.revokeObjectURL(url), OPENED_BLOB_TTL_MS);
    return url;
  };
}
