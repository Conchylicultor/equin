import { markSvgProblem, type MapMark } from "@plugins/map/core";

/**
 * Marks rasterized once per look: a mark's SVG decoded as an image and drawn
 * at the device's pixel ratio into a bitmap, keyed by `key@dpr`. Equal keys
 * are identical pixels (`MapMark.key`), so pins that look alike share one.
 *
 * A mark that cannot be rasterized (its SVG refused, the image failing to
 * decode) rejects its sprite — and the layer that asked rethrows it.
 */
export class SpriteCache {
  private readonly ready = new Map<string, ImageBitmap>();
  private readonly loading = new Map<string, Promise<ImageBitmap>>();

  private static keyOf(mark: MapMark, dpr: number): string {
    return `${mark.key}@${dpr}`;
  }

  /** The mark's bitmap, or `undefined` while it is not rasterized yet. */
  get(mark: MapMark, dpr: number): ImageBitmap | undefined {
    return this.ready.get(SpriteCache.keyOf(mark, dpr));
  }

  /** Rasterize `mark` (once; a second ask joins the first). */
  load(mark: MapMark, dpr: number): Promise<ImageBitmap> {
    const key = SpriteCache.keyOf(mark, dpr);
    const hit = this.ready.get(key);
    if (hit !== undefined) return Promise.resolve(hit);
    const pending = this.loading.get(key);
    if (pending !== undefined) return pending;
    const next = rasterize(mark, dpr).then((bitmap) => {
      this.loading.delete(key);
      this.ready.set(key, bitmap);
      return bitmap;
    });
    this.loading.set(key, next);
    return next;
  }

  dispose(): void {
    for (const bitmap of this.ready.values()) bitmap.close();
    this.ready.clear();
    this.loading.clear();
  }
}

async function rasterize(mark: MapMark, dpr: number): Promise<ImageBitmap> {
  const problem = markSvgProblem(mark.svg);
  if (problem !== null) {
    throw new Error(`map mark ${mark.key}: its SVG holds ${problem}`);
  }
  const url = URL.createObjectURL(
    new Blob([mark.svg], { type: "image/svg+xml" }),
  );
  try {
    const img = new Image(mark.width, mark.height);
    img.src = url;
    await img.decode();
    const w = Math.ceil(mark.width * dpr);
    const h = Math.ceil(mark.height * dpr);
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d");
    if (ctx === null) throw new Error("OffscreenCanvas has no 2d context");
    // An SVG image re-renders at the size it is drawn at: crisp at any ratio.
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.transferToImageBitmap();
  } finally {
    URL.revokeObjectURL(url);
  }
}
