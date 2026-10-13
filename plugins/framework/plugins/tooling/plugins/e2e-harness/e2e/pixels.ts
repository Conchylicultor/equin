/**
 * Reading pixels back off the page — the assertion of last resort, for claims
 * about what the user actually SEES.
 *
 * Some UI claims are not expressible in the DOM. A gradient painted by a
 * pseudo-element has no rect to query, no text to match and no attribute to
 * read; `getComputedStyle(el, "::before")` reports the opacity it was *given*,
 * which stays `1` whether the strip lands over the content or half a panel away.
 * That exact gap shipped a scroll fade whose top strip was fully opaque and
 * positioned outside the visible box: every DOM-level check passed, and only a
 * screenshot caught it.
 *
 * So: screenshot the region, hand the PNG back into the page as a data URL, and
 * let the browser decode it onto a canvas. No image dependency, no format
 * parsing here — Chromium already owns a PNG decoder.
 *
 * Cost is real (the pixels cross the bridge as base64), so sample the BAND you
 * are asserting about, not the whole page.
 */
import type { Page } from "playwright";

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PixelGrid {
  /** Sampled size in CSS pixels (device pixel ratio is normalized away). */
  width: number;
  height: number;
  /** Colour at a point, in coordinates relative to the sampled rect. */
  at(x: number, y: number): Rgba;
}

/** Max per-channel difference — 0 is identical, 255 is black vs white. */
export function colorDistance(a: Rgba, b: Rgba): number {
  return Math.max(
    Math.abs(a.r - b.r),
    Math.abs(a.g - b.g),
    Math.abs(a.b - b.b),
  );
}

/**
 * Sample the composited colours inside `rect` (viewport coordinates — what
 * `locator.boundingBox()` returns).
 *
 * Throws rather than returning an empty grid if the capture or decode fails: a
 * pixel assertion that silently reads nothing would pass every "is it covered?"
 * check by default.
 */
export async function samplePixels(page: Page, rect: Rect): Promise<PixelGrid> {
  const clip = {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height)),
  };
  const png = (await page.screenshot({ clip })).toString("base64");
  const decoded = await page.evaluate(async (png: string) => {
    const img = new Image();
    img.src = `data:image/png;base64,${png}`;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("samplePixels: no 2d context");
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, img.width, img.height).data;
    // Base64 of the raw RGBA bytes: a plain number[] would cross the bridge as
    // JSON, ~10x the size for the same pixels.
    let bin = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < data.length; i += CHUNK)
      bin += String.fromCharCode(...data.subarray(i, i + CHUNK));
    return { b64: btoa(bin), width: img.width, height: img.height };
  }, png);

  const bytes = Buffer.from(decoded.b64, "base64");
  if (bytes.length !== decoded.width * decoded.height * 4)
    throw new Error(
      `samplePixels: decoded ${bytes.length} bytes for ${decoded.width}×${decoded.height}`,
    );
  // A HiDPI capture is larger than the CSS rect it was taken from; report CSS
  // pixels so callers can compare against layout numbers without a scale factor.
  const scale = decoded.width / clip.width;
  return {
    width: clip.width,
    height: clip.height,
    at(x: number, y: number): Rgba {
      const px = Math.min(
        decoded.width - 1,
        Math.max(0, Math.round(x * scale)),
      );
      const py = Math.min(
        decoded.height - 1,
        Math.max(0, Math.round(y * scale)),
      );
      const i = (decoded.width * py + px) * 4;
      return {
        r: bytes[i]!,
        g: bytes[i + 1]!,
        b: bytes[i + 2]!,
        a: bytes[i + 3]!,
      };
    },
  };
}

/** A capture's verdict: one flat colour (and which), or real content. */
export type Flatness = { flat: true; color: Rgba } | { flat: false };

/**
 * Is this capture ONE flat colour — a page that never painted?
 *
 * A screenshot of an app that has not rendered yet (still booting on a loaded
 * machine, a dead chunk, a crashed root) is the document's bare background:
 * every pixel the same. It decodes, it is a valid PNG, and `snap()` used to
 * print `wrote …` for it — so agents took the black rectangle for evidence and
 * reasoned from it. No real screen is a single colour, so "flat" is a cheap,
 * app-agnostic proof that nothing was drawn.
 *
 * `tolerance` is the per-channel distance (see `colorDistance`) still counted as
 * the same colour, so dithering or a 1-step gradient band does not count as
 * content. Decoded in the page, like `samplePixels`; only the verdict crosses
 * the bridge.
 */
export async function flatness(
  page: Page,
  png: Buffer,
  tolerance = 4,
): Promise<Flatness> {
  return page.evaluate(
    async ({ b64, tolerance }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("flatness: no 2d context");
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, img.width, img.height).data;
      const r = d[0]!,
        g = d[1]!,
        b = d[2]!,
        a = d[3]!;
      for (let i = 4; i < d.length; i += 4) {
        if (
          Math.abs(d[i]! - r) > tolerance ||
          Math.abs(d[i + 1]! - g) > tolerance ||
          Math.abs(d[i + 2]! - b) > tolerance
        )
          return { flat: false as const };
      }
      return { flat: true as const, color: { r, g, b, a } };
    },
    { b64: png.toString("base64"), tolerance },
  );
}

/** `#rrggbb`, for a log line. */
export function hexColor(c: Rgba): string {
  return `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}
